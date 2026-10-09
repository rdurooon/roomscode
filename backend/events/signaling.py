import re

from flask import current_app, request
from flask_socketio import emit

from ..rooms.manager import room_manager
from .rate_limit import SlidingWindowRateLimiter

# Id de uma tentativa de conexão de vídeo, gerado pelo navegador do espectador.
# Todas as mensagens daquela tentativa o carregam, então sinais atrasados de
# uma tentativa anterior (que o espectador já abandonou) são reconhecidos e
# descartados em vez de corromper a conexão nova.
_SESSION_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

_screen_state_rate_limiter = SlidingWindowRateLimiter()
_offer_request_rate_limiter = SlidingWindowRateLimiter()


def _role_in_room(room, sid):
    """Retorna 'host', 'spectator' ou None (sid não pertence a essa sala —
    inclui o caso do sid da extensão VS Code, que nunca participa do
    WebRTC)."""
    if room.host_sid == sid:
        return "host"
    if sid in room.spectators:
        return "spectator"
    return None


def _signal_kind(signal):
    """Classifica o tipo de mensagem de sinalização a partir do formato que
    o webrtc-client.js realmente envia: {type: 'offer'|'answer', sdp: ...}
    para oferta/resposta, ou {candidate: {...}} para ICE candidates."""
    if not isinstance(signal, dict):
        return None
    signal_type = signal.get("type")
    if signal_type in ("offer", "answer"):
        return signal_type
    if "candidate" in signal:
        return "candidate"
    return None


# Quais tipos de sinal cada papel tem permissão de *enviar*. Um Espectador
# nunca inicia uma oferta (isso corromperia o fluxo mesh: só o Host
# apresenta tela), e o Host nunca manda "answer".
_ALLOWED_SIGNAL_KINDS_BY_ROLE = {
    "host": {"offer", "candidate"},
    "spectator": {"answer", "candidate"},
}


def _valid_session(session):
    return isinstance(session, str) and bool(_SESSION_PATTERN.match(session))


def register_signaling_events(socketio):
    """Sinalização do vídeo da tela do Host (WebRTC mesh). O conteúdo do
    vídeo em si nunca passa pelo backend — só metadados de conexão.

    Fluxo: o ESPECTADOR pede a oferta (`video_request_offer`) quando já está
    pronto pra respondê-la; o Host monta uma conexão nova pra aquela tentativa
    e oferece. Quem pede é sempre quem está esperando, então não há oferta
    "no vazio", e pedir de novo (retentativa) refaz tudo do zero."""

    @socketio.on("webrtc_signal")
    def handle_webrtc_signal(data):
        data = data or {}
        target_sid = data.get("target_sid")
        signal = data.get("signal")
        session = data.get("session")
        if not target_sid or signal is None or not _valid_session(session):
            return

        room = room_manager.get_room_for_sid(request.sid)
        if room is None:
            return  # remetente não está em nenhuma sala (ou já saiu dela)

        sender_role = _role_in_room(room, request.sid)
        if sender_role is None:
            return

        # O alvo precisa estar na MESMA sala do remetente — sem isso, um
        # socket qualquer poderia mandar sinalização WebRTC pra qualquer
        # outro socket conectado ao servidor, de qualquer sala.
        if _role_in_room(room, target_sid) is None:
            return

        signal_kind = _signal_kind(signal)
        if signal_kind is None or signal_kind not in _ALLOWED_SIGNAL_KINDS_BY_ROLE[sender_role]:
            return

        # Todo socket entra automaticamente em uma "sala" com o próprio sid,
        # então emitir com room=target_sid entrega direto pra conexão certa.
        emit(
            "webrtc_signal",
            {"sender_sid": request.sid, "signal": signal, "session": session},
            room=target_sid,
        )

    @socketio.on("video_request_offer")
    def handle_video_request_offer(data):
        """O espectador pede a oferta de vídeo do Host (entrada, F5,
        retentativa ou "Tentar novamente")."""
        data = data or {}
        session = data.get("session")
        if not _valid_session(session):
            return

        room = room_manager.get_room_for_sid(request.sid)
        if room is None or _role_in_room(room, request.sid) != "spectator":
            return

        if _offer_request_rate_limiter.is_limited(
            request.sid,
            current_app.config["VIDEO_OFFER_REQUEST_RATE_LIMIT_COUNT"],
            current_app.config["VIDEO_OFFER_REQUEST_RATE_LIMIT_WINDOW_SECONDS"],
        ):
            return

        if not room.screen_sharing or room.host_sid is None:
            # Não há tela agora: devolve só pra quem pediu, que volta pro
            # "aguardando compartilhamento" (o aviso geral já teria chegado
            # se ele estivesse na sala na hora, mas pode ter se perdido).
            emit("screen_share_stopped", {})
            return

        emit(
            "video_offer_requested",
            {"sid": request.sid, "session": session},
            room=room.host_sid,
        )

    def _set_screen_state(active):
        room = room_manager.get_room_for_sid(request.sid)
        if room is None or room.host_sid != request.sid:
            # Só o Host da sala pode anunciar o estado da tela.
            return
        if _screen_state_rate_limiter.is_limited(
            request.sid,
            current_app.config["SCREEN_SHARE_STATE_RATE_LIMIT_COUNT"],
            current_app.config["SCREEN_SHARE_STATE_RATE_LIMIT_WINDOW_SECONDS"],
        ):
            return
        if room_manager.set_screen_sharing(request.sid, active) is None:
            return
        event = "screen_share_started" if active else "screen_share_stopped"
        emit(event, {}, room=room.code, include_self=False)

    @socketio.on("screen_share_started")
    def handle_screen_share_started(_data=None):
        """O Host começou a compartilhar: espectadores presentes pedem a oferta."""
        _set_screen_state(True)

    @socketio.on("screen_share_stopped")
    def handle_screen_share_stopped(_data=None):
        """O Host parou de compartilhar. Sinal explícito (em vez de depender
        só do estado da track WebRTC, que varia entre navegadores)."""
        _set_screen_state(False)
