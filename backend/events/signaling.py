from flask import request
from flask_socketio import emit

from ..rooms.manager import room_manager


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


def register_signaling_events(socketio):
    """Repassa mensagens de sinalização WebRTC (offer/answer/ICE candidates)
    entre Host e Espectadores. O conteúdo do vídeo em si nunca passa pelo
    backend — só esses metadados de conexão.
    """

    @socketio.on("webrtc_signal")
    def handle_webrtc_signal(data):
        data = data or {}
        target_sid = data.get("target_sid")
        signal = data.get("signal")
        if not target_sid or signal is None:
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
            {"sender_sid": request.sid, "signal": signal},
            room=target_sid,
        )

    @socketio.on("screen_share_stopped")
    def handle_screen_share_stopped(data):
        """Sinal explícito de que o Host parou de compartilhar a tela.

        Não dependemos só do estado da track do WebRTC (ontrack/ended)
        chegando nos Espectadores, porque esse comportamento varia entre
        navegadores e nem sempre dispara de forma confiável quando o Host
        para o compartilhamento pelo nosso próprio botão.
        """
        data = data or {}
        code = data.get("room_code", "")
        room = room_manager.get_room(code)
        if room is None or room.host_sid != request.sid:
            # Só o Host da sala pode anunciar que parou de compartilhar.
            return

        emit("screen_share_stopped", {}, room=room.code, include_self=False)
