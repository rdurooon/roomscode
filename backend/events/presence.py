from flask import current_app, request
from flask_socketio import emit, join_room

from ..net import get_client_ip
from ..rooms.manager import room_manager
from .rate_limit import SlidingWindowRateLimiter

_room_create_rate_limiter = SlidingWindowRateLimiter()
_spectator_join_rate_limiter = SlidingWindowRateLimiter()


def _expire_host_grace_after_timeout(socketio, code, disconnected_at, grace_seconds):
    """Roda em background task (greenlet do eventlet) desde o momento em que
    o Host cai. `socketio.sleep` (não `time.sleep`!) cede o controle
    cooperativamente, sem travar o worker. Ao acordar, só encerra a sala se
    ela ainda estiver esperando exatamente por ESSA queda — ver comentário
    em RoomManager.finalize_expired_room."""
    socketio.sleep(grace_seconds)
    room = room_manager.finalize_expired_room(code, disconnected_at)
    if room is None:
        return
    # Usa socketio.emit (método da instância), não o helper `emit()` do
    # flask_socketio — este último exige um contexto de request/sid de
    # origem, que não existe aqui dentro de uma background task.
    socketio.emit(
        "host_left",
        {"code": "HOST_LEFT_TIMEOUT"},
        room=code,
    )


def register_presence_events(socketio):

    @socketio.on("host_create_room")
    def handle_host_create_room(data):
        if _room_create_rate_limiter.is_limited(
            get_client_ip(),
            current_app.config["ROOM_CREATE_RATE_LIMIT_COUNT"],
            current_app.config["ROOM_CREATE_RATE_LIMIT_WINDOW_SECONDS"],
        ):
            emit("join_error", {"code": "TOO_MANY_ROOMS_CREATED"})
            return

        name = (data or {}).get("name", "Host")
        room = room_manager.create_room(host_sid=request.sid, host_name=name)
        join_room(room.code)
        # ext_token e host_session_token só vão para o Host que acabou de
        # criar a sala (emit sem `room=`, ou seja, resposta direta a este
        # socket) — nenhum dos dois é incluído em `joined_room`, que é o que
        # os Espectadores recebem. host_session_token fica guardado pelo
        # navegador do Host (sessionStorage) e volta sozinho numa tentativa
        # de reconexão (ver handle_host_reconnect).
        emit(
            "room_created",
            {
                "code": room.code,
                "host_name": name,
                "ext_token": room.ext_token,
                "host_session_token": room.host_session_token,
            },
        )

    @socketio.on("host_reconnect")
    def handle_host_reconnect(data):
        """O navegador do Host (reconexão automática do socket.io depois de
        uma queda, ou o próprio usuário voltando à página) tenta retomar uma
        sala que ainda está em estado de graça (ver mark_host_disconnected
        no disconnect abaixo). Precisa do código da sala E do
        host_session_token guardado no sessionStorage — o código sozinho
        não basta, pois é semi-público."""
        data = data or {}
        code = data.get("room_code", "")
        host_session_token = data.get("host_session_token", "")

        room = room_manager.reconnect_host(code, host_session_token, request.sid)
        if room is None:
            emit(
                "host_reconnect_failed",
                {"code": "HOST_RECONNECT_FAILED"},
            )
            return

        join_room(room.code)
        emit(
            "host_reconnect_success",
            {
                "code": room.code,
                "host_name": room.host_name,
                "ext_token": room.ext_token,
                "code_visible_to_spectators": room.code_visible_to_spectators,
                "extension_connected": room.extension_sid is not None,
                "spectator_sids": list(room.spectators.keys()),
                "tabs": [
                    {
                        "tabId": tab_id,
                        "filename": f.filename,
                        "language": f.language,
                        "content": f.content,
                    }
                    for tab_id, f in room.files.items()
                ],
                "host_cursor": room.host_cursor,
                "spectators": list(room.spectators.values()),
            },
        )
        emit(
            "host_reconnected",
            {"code": "HOST_RECONNECTED"},
            room=room.code,
            include_self=False,
        )

    @socketio.on("spectator_join_room")
    def handle_spectator_join(data):
        if _spectator_join_rate_limiter.is_limited(
            get_client_ip(),
            current_app.config["SPECTATOR_JOIN_RATE_LIMIT_COUNT"],
            current_app.config["SPECTATOR_JOIN_RATE_LIMIT_WINDOW_SECONDS"],
        ):
            emit("join_error", {"code": "TOO_MANY_JOIN_ATTEMPTS"})
            return

        data = data or {}
        code = data.get("room_code", "")
        name = data.get("name", "Espectador")

        room = room_manager.add_spectator(code, sid=request.sid, name=name)
        if room is None:
            emit("join_error", {"code": "ROOM_NOT_FOUND"})
            return

        join_room(room.code)

        emit(
            "joined_room",
            {
                "code": room.code,
                "host_name": room.host_name,
                "code_visible_to_spectators": room.code_visible_to_spectators,
                "tabs": [
                    {
                        "tabId": tab_id,
                        "filename": f.filename,
                        "language": f.language,
                        "content": f.content,
                    }
                    for tab_id, f in room.files.items()
                ],
                "host_cursor": room.host_cursor,
                "spectators": list(room.spectators.values()),
            },
        )

        emit(
            "spectator_joined",
            {"sid": request.sid, "name": name, "spectators": list(room.spectators.values())},
            room=room.code,
            include_self=False,
        )

    @socketio.on("extension_attach")
    def handle_extension_attach(data):
        """A extensão do VS Code do Host usa esse evento para entrar na sala
        e começar a publicar `file_full_content` / `file_diff` /
        `tabs_full_state` / `host_cursor_line`.

        Autenticação: só o token de controle (`ext_token`) é usado — não o
        código de convite da sala (esse é entregue a espectadores e é
        considerado semi-público). O token já identifica a sala sozinho
        (ver RoomManager.attach_extension_by_token), então a extensão não
        precisa mais que o usuário digite/cole o código da sala também. Só
        depois de validado esse token o sid da extensão é guardado como
        canal confiável da sala (ver RoomManager.is_trusted_sender), e só
        então os eventos de conteúdo de arquivo passam a ser aceitos vindos
        dela.
        """
        data = data or {}
        ext_token = data.get("ext_token", "")

        room = room_manager.attach_extension_by_token(ext_token, request.sid)
        if room is None:
            # i18n: intencionalmente ainda texto pronto, não "code" — este
            # evento é consumido pela extensão VS Code (Node.js), não pelo
            # navegador. A extensão vai ganhar seu próprio mecanismo de
            # idioma nativo do VS Code (package.nls.*.json / vscode.l10n)
            # na etapa dedicada a ela, em vez de reusar o dicionário web.
            emit("attach_error", {"message": "Token da extensão inválido ou sala não encontrada."})
            return

        join_room(room.code)
        emit("attached", {"code": room.code})

        # Avisa o navegador do Host que a extensão conectou, direto pro sid dele (não pra espectadores).
        if room.host_sid:
            emit("extension_status", {"connected": True}, room=room.host_sid)

    @socketio.on("host_end_room")
    def handle_host_end_room(data):
        """O Host saiu deliberadamente (confirmou o aviso de sair da sala).
        Encerra a sala agora, com uma mensagem diferente da queda de
        conexão — o cliente ainda chama socket.disconnect() logo em
        seguida, mas como a sala já não existe mais nesse ponto, o handler
        de disconnect abaixo não encontra nada pra fazer (sem mensagem
        duplicada)."""
        code = (data or {}).get("room_code", "")
        room, was_host, _was_extension = room_manager.remove_sid(request.sid)
        if room is None or not was_host or room.code != code:
            return

        emit("host_left", {"code": "HOST_LEFT"}, room=room.code)

    @socketio.on("disconnect")
    def handle_disconnect():
        sid = request.sid
        room = room_manager.get_room_for_sid(sid)
        if room is None:
            return

        if room.host_sid == sid:
            # ANTES: qualquer queda do Host apagava a sala na hora
            # (remove_sid), sem chance nenhuma de reconexão — uma
            # instabilidade de 2 segundos de wifi tinha o mesmo efeito de o
            # Host fechar a aba de propósito. Agora a sala entra em estado
            # de graça: fica de pé, espectadores são avisados com uma
            # contagem regressiva, e só é encerrada de fato depois do prazo
            # configurado (HOST_RECONNECT_GRACE_SECONDS) — e mesmo assim,
            # só se ninguém reconectou nesse meio tempo.
            grace_seconds = current_app.config["HOST_RECONNECT_GRACE_SECONDS"]
            disconnected_room = room_manager.mark_host_disconnected(sid)
            if disconnected_room is None:
                return

            emit(
                "host_disconnected_grace",
                {
                    "code": "HOST_DISCONNECTED_GRACE",
                    "grace_seconds": grace_seconds,
                },
                room=disconnected_room.code,
            )
            socketio.start_background_task(
                _expire_host_grace_after_timeout,
                socketio,
                disconnected_room.code,
                disconnected_room.host_disconnected_at,
                grace_seconds,
            )
            return

        room, was_host, was_extension = room_manager.remove_sid(sid)
        if room is None:
            return

        if was_extension:
            # A extensão VS Code caiu, mas o Host (navegador) continua
            # conectado e a sala segue de pé — não há espectadores a
            # notificar sobre isso, é um detalhe interno da sala. O Host
            # precisa saber, porém, pra voltar a mostrar o convite de
            # "baixar/conectar a extensão" no painel de código (ver
            # handle_extension_attach acima, que avisa o inverso).
            if room.host_sid:
                emit("extension_status", {"connected": False}, room=room.host_sid)
            return

        emit(
            "spectator_left",
            {"sid": sid, "spectators": list(room.spectators.values())},
            room=room.code,
        )
