import random
import secrets
import string
import threading
import time
from typing import Dict, List, Optional, Tuple

from .models import OpenFile, Room


class RoomManager:
    """Mantém todas as salas ativas em memória.

    Para o MVP isso é suficiente (1 processo Flask). Se o projeto crescer
    para múltiplos workers, essa classe deve ser substituída por algo
    apoiado em Redis, mantendo a mesma interface pública usada pelos
    módulos em `events/`.
    """

    def __init__(self, code_length: int = 6):
        self._rooms: Dict[str, Room] = {}
        self._sid_to_code: Dict[str, str] = {}
        # Índice reverso token da extensão -> código da sala. Existe porque a
        # extensão do VS Code agora se conecta só com o token (ver
        # attach_extension_by_token) — sem código de sala digitado, o token
        # sozinho precisa bastar pra encontrar a sala.
        self._token_to_code: Dict[str, str] = {}
        self._code_length = code_length
        self._lock = threading.Lock()

    def _generate_code(self) -> str:
        alphabet = string.ascii_uppercase + string.digits
        while True:
            code = "".join(random.choices(alphabet, k=self._code_length))
            if code not in self._rooms:
                return code

    @staticmethod
    def _generate_ext_token() -> str:
        # Token de controle da extensão: não precisa ser digitável (ao
        # contrário do código de sala), então usamos algo bem mais longo e
        # imprevisível — só é copiado/colado, nunca digitado à mão.
        return secrets.token_urlsafe(24)

    @staticmethod
    def _generate_host_session_token() -> str:
        # Mesma ideia do ext_token: nunca digitado, só guardado pelo
        # navegador do Host (sessionStorage) e devolvido automaticamente
        # numa tentativa de reconexão.
        return secrets.token_urlsafe(24)

    def create_room(self, host_sid: str, host_name: str = "") -> Room:
        with self._lock:
            code = self._generate_code()
            ext_token = self._generate_ext_token()
            host_session_token = self._generate_host_session_token()
            room = Room(
                code=code,
                host_sid=host_sid,
                host_name=host_name,
                ext_token=ext_token,
                host_session_token=host_session_token,
            )
            self._rooms[code] = room
            self._sid_to_code[host_sid] = code
            self._token_to_code[ext_token] = code
            return room

    def get_room(self, code: str) -> Optional[Room]:
        if not code:
            return None
        return self._rooms.get(code.upper())

    def get_room_for_sid(self, sid: str) -> Optional[Room]:
        """Retorna a sala à qual esse sid pertence (Host, Espectador ou
        extensão), ou None se o sid não estiver associado a nenhuma sala."""
        code = self._sid_to_code.get(sid)
        if code is None:
            return None
        return self._rooms.get(code)

    def is_trusted_sender(self, code: str, sid: str) -> bool:
        """True se `sid` for o Host da sala ou a extensão VS Code anexada a
        ela — os dois únicos canais autorizados a publicar conteúdo de
        arquivo/cursor. Qualquer outro sid (espectador ou socket qualquer
        que nunca entrou na sala) é rejeitado."""
        room = self._rooms.get(code.upper()) if code else None
        if room is None:
            return False
        return sid == room.host_sid or (room.extension_sid is not None and sid == room.extension_sid)

    def attach_extension_by_token(self, ext_token: str, sid: str) -> Optional[Room]:
        """Autentica a extensão VS Code na sala usando só o token de
        controle — sem código de sala digitado. O token (índice reverso em
        `_token_to_code`) já identifica a sala sozinho; `secrets.compare_digest`
        confirma a igualdade exata como segunda camada antes de confiar
        nesse sid."""
        if not ext_token:
            return None
        with self._lock:
            code = self._token_to_code.get(ext_token)
            room = self._rooms.get(code) if code else None
            if room is None or not secrets.compare_digest(ext_token, room.ext_token):
                return None
            room.extension_sid = sid
            self._sid_to_code[sid] = room.code
            return room

    @staticmethod
    def _name_key(name) -> str:
        return str(name).strip().casefold()

    def add_spectator(self, code: str, sid: str, name: str, client_id: str = "") -> Optional[Room]:
        with self._lock:
            room = self._rooms.get(code.upper()) if code else None
            if room is None:
                return None
            room.spectators[sid] = name
            room.spectator_client_ids[sid] = client_id
            # Quem volta depois de uma expulsão (ou de uma restrição de chat)
            # continua restrito: reconhecido pelo id do navegador ou pelo nome.
            if (client_id and client_id in room.restricted_client_ids) or self._name_key(name) in room.restricted_names:
                room.muted_sids.add(sid)
            self._sid_to_code[sid] = room.code
            return room

    @staticmethod
    def name_error(name, min_chars: int, reserved=()) -> Optional[str]:
        """Código de erro (chave socket.<código em minúsculo> nas traduções) se o nome não for aceito, ou None."""
        if not isinstance(name, str) or len(name.strip()) < min_chars:
            return "NAME_TOO_SHORT"
        if RoomManager._name_key(name) in {RoomManager._name_key(r) for r in reserved}:
            return "NAME_RESERVED"
        return None

    def join_spectator(
        self, code: str, sid: str, name, client_id: str = "", min_chars: int = 4, reserved=()
    ) -> Tuple[Optional[Room], Optional[str], Optional[str]]:
        """Entrada de espectador com validação do nome (tamanho mínimo, nome reservado e nome já usado na sala,
        incluindo o do Host; sem diferenciar maiúsculas de minúsculas).

        Devolve (sala, erro, sid_substituído). Se o nome já estiver com um espectador de MESMO id de navegador,
        é a mesma pessoa voltando (F5 ou queda) antes de o servidor notar que o socket antigo caiu: a entrada
        antiga é substituída e seu sid volta em sid_substituído, para quem chamou avisar a sala.
        """
        with self._lock:
            room = self._rooms.get(code.upper()) if isinstance(code, str) and code else None
            if room is None:
                return None, "ROOM_NOT_FOUND", None

            error = self.name_error(name, min_chars, reserved)
            if error:
                return None, error, None

            name = name.strip()
            key = self._name_key(name)
            if key == self._name_key(room.host_name):
                return None, "NAME_TAKEN", None

            replaced_sid = None
            for other_sid, other_name in room.spectators.items():
                if other_sid == sid or self._name_key(other_name) != key:
                    continue
                if client_id and room.spectator_client_ids.get(other_sid, "") == client_id:
                    replaced_sid = other_sid
                    break
                return None, "NAME_TAKEN", None

            if replaced_sid is not None:
                room.spectators.pop(replaced_sid, None)
                room.spectator_client_ids.pop(replaced_sid, None)
                room.muted_sids.discard(replaced_sid)
                self._sid_to_code.pop(replaced_sid, None)

            room.spectators[sid] = name
            room.spectator_client_ids[sid] = client_id
            if (client_id and client_id in room.restricted_client_ids) or key in room.restricted_names:
                room.muted_sids.add(sid)
            self._sid_to_code[sid] = room.code
            return room, None, replaced_sid

    def is_chat_muted(self, room: Room, sid: str) -> bool:
        return sid in room.muted_sids

    def get_roster(self, room: Room) -> List[dict]:
        """Lista de espectadores com o sid de cada um e se o chat está
        restrito — só vai para o Host (os espectadores recebem só nomes)."""
        return [
            {"sid": sid, "name": name, "muted": sid in room.muted_sids}
            for sid, name in room.spectators.items()
        ]

    def _restrict_identity(self, room: Room, sid: str) -> None:
        client_id = room.spectator_client_ids.get(sid, "")
        if client_id:
            room.restricted_client_ids.add(client_id)
        room.restricted_names.add(self._name_key(room.spectators.get(sid, "")))

    def _release_identity(self, room: Room, sid: str) -> None:
        client_id = room.spectator_client_ids.get(sid, "")
        room.restricted_client_ids.discard(client_id)
        room.restricted_names.discard(self._name_key(room.spectators.get(sid, "")))

    def set_chat_muted(self, code: str, sid: str, muted: bool) -> Optional[Room]:
        """Restringe/libera o chat de um espectador. A restrição também vale
        pra esse espectador se ele sair e voltar (ver add_spectator)."""
        with self._lock:
            room = self._rooms.get(code.upper()) if code else None
            if room is None or sid not in room.spectators:
                return None
            if muted:
                room.muted_sids.add(sid)
                self._restrict_identity(room, sid)
            else:
                room.muted_sids.discard(sid)
                self._release_identity(room, sid)
            return room

    def set_chat_all_muted(self, code: str, muted: bool) -> Optional[Room]:
        """Bloqueia/libera o chat de TODOS os espectadores da sala (vale também para quem entrar depois).
        Não mexe nas restrições individuais: ao liberar, quem estava restrito continua restrito."""
        with self._lock:
            room = self._rooms.get(code.upper()) if code else None
            if room is None:
                return None
            room.chat_all_muted = muted
            return room

    def kick_spectator(self, code: str, sid: str) -> Optional[Room]:
        """Remove o espectador da sala. Ele pode voltar, mas já volta com o
        chat restrito (a identidade dele fica na lista de restrições)."""
        with self._lock:
            room = self._rooms.get(code.upper()) if code else None
            if room is None or sid not in room.spectators:
                return None
            self._restrict_identity(room, sid)
            room.spectators.pop(sid, None)
            room.spectator_client_ids.pop(sid, None)
            room.muted_sids.discard(sid)
            self._sid_to_code.pop(sid, None)
            return room

    def remove_sid(self, sid: str) -> Tuple[Optional[Room], bool, bool]:
        """Remove um sid (Host, Espectador ou extensão) de qualquer sala.

        Retorna (sala_afetada, era_host, era_extensão). Se o Host sair, a
        sala inteira é encerrada, já que não faz sentido continuar sem
        apresentador.
        """
        with self._lock:
            code = self._sid_to_code.pop(sid, None)
            if code is None:
                return None, False, False

            room = self._rooms.get(code)
            if room is None:
                return None, False, False

            was_host = room.host_sid == sid
            was_extension = (not was_host) and room.extension_sid == sid
            if was_host:
                del self._rooms[code]
                self._token_to_code.pop(room.ext_token, None)
                for spectator_sid in list(room.spectators.keys()):
                    self._sid_to_code.pop(spectator_sid, None)
                if room.extension_sid is not None:
                    self._sid_to_code.pop(room.extension_sid, None)
            elif was_extension:
                room.extension_sid = None
            else:
                room.spectators.pop(sid, None)
                room.spectator_client_ids.pop(sid, None)
                room.muted_sids.discard(sid)

            return room, was_host, was_extension

    # ---- Reconexão do Host (queda de conexão ≠ saída deliberada) ----
    #
    # Antes, qualquer disconnect do Host (mesmo uma queda de 1s) passava por
    # remove_sid() e derrubava a sala na hora, sem chance de o Host voltar.
    # Agora esse caminho fica em dois passos: mark_host_disconnected() só
    # tira o Host da sala como "sender confiável" e marca a hora da queda,
    # SEM apagar a sala; reconnect_host() (se o Host voltar a tempo, com o
    # token certo) desfaz isso; finalize_expired_room() (chamado pelo
    # `events/presence.py` depois do tempo de graça configurado) é quem de
    # fato apaga a sala, e só se ninguém reconectou nesse meio tempo.

    def mark_host_disconnected(self, sid: str) -> Optional[Room]:
        """Chamado quando o socket do Host cai. Tira o sid do índice (pra
        que ninguém mais consiga usá-lo) e marca a sala como "aguardando o
        host voltar", mas NÃO apaga a sala — isso é responsabilidade de
        finalize_expired_room(), depois do tempo de graça, e só se ninguém
        reconectou. Espectadores e a extensão (se ainda conectada) não são
        afetados: continuam na sala normalmente."""
        with self._lock:
            code = self._sid_to_code.pop(sid, None)
            if code is None:
                return None
            room = self._rooms.get(code)
            if room is None or room.host_sid != sid:
                return None
            room.host_sid = None
            room.host_disconnected_at = time.monotonic()
            # A captura de tela vive na página do Host; sem socket não há
            # mais transmissão (o Host precisa clicar de novo ao voltar).
            room.screen_sharing = False
            return room

    def set_screen_sharing(self, sid: str, active: bool) -> Optional[Room]:
        """Liga/desliga o estado "Host compartilhando a tela". Só vale se
        quem pediu é o Host atual da sala; retorna a sala, ou None."""
        with self._lock:
            code = self._sid_to_code.get(sid)
            room = self._rooms.get(code) if code else None
            if room is None or room.host_sid != sid:
                return None
            room.screen_sharing = active
            return room

    def reconnect_host(self, code: str, host_session_token: str, new_sid: str) -> Optional[Room]:
        """Tenta reconectar um Host a uma sala em estado de graça. Exige o
        código certo E o host_session_token certo (comparação em tempo
        constante) — o código sozinho não basta, já que é semi-público
        (compartilhado com espectadores). Retorna None se a sala não existe,
        já não está mais em estado de graça (host_sid não é None — ou já
        reconectou, ou nunca chegou a cair) ou o token não confere."""
        if not code or not host_session_token:
            return None
        with self._lock:
            room = self._rooms.get(code.upper())
            if room is None or room.host_sid is not None or room.host_disconnected_at is None:
                return None
            if not secrets.compare_digest(host_session_token, room.host_session_token):
                return None
            room.host_sid = new_sid
            room.host_disconnected_at = None
            self._sid_to_code[new_sid] = room.code
            return room

    def finalize_expired_room(self, code: str, expected_disconnected_at: float) -> Optional[Room]:
        """Chamado depois do tempo de graça. `expected_disconnected_at` é o
        timestamp exato da queda que originou essa espera — se o Host já
        reconectou (host_disconnected_at volta a ser None) ou caiu de novo
        depois de reconectar (um novo timestamp, diferente do esperado),
        essa chamada não faz nada e devolve None: encerrar a sala aqui seria
        derrubar uma sessão que já está de pé de novo."""
        with self._lock:
            room = self._rooms.get(code)
            if room is None:
                return None
            if room.host_sid is not None or room.host_disconnected_at != expected_disconnected_at:
                return None
            del self._rooms[code]
            self._token_to_code.pop(room.ext_token, None)
            for spectator_sid in list(room.spectators.keys()):
                self._sid_to_code.pop(spectator_sid, None)
            if room.extension_sid is not None:
                self._sid_to_code.pop(room.extension_sid, None)
            return room

    # ---- Abas / arquivos ----

    def set_tabs(self, code: str, tabs: List[dict]) -> Optional[Room]:
        """Substitui o conjunto inteiro de abas abertas pela lista recebida
        da extensão (fonte da verdade). Abas que não aparecem mais na lista
        são removidas — é assim que o fechamento de uma aba é refletido."""
        room = self._rooms.get(code.upper()) if code else None
        if room is None:
            return None

        new_ids = {tab.get("tabId") for tab in tabs}

        for tab_id in list(room.files.keys()):
            if tab_id not in new_ids:
                del room.files[tab_id]
                room.host_cursor.pop(tab_id, None)

        if room.host_active_tab and room.host_active_tab not in new_ids:
            room.host_active_tab = ""

        for tab in tabs:
            tab_id = tab.get("tabId")
            if not tab_id:
                continue
            room.files[tab_id] = OpenFile(
                filename=tab.get("filename", ""),
                language=tab.get("language", ""),
                content=tab.get("content", ""),
                path=tab.get("path", ""),
            )

        return room

    def update_file(self, code: str, tab_id: str, filename: str, language: str, content: str, path: str = "") -> None:
        room = self._rooms.get(code.upper()) if code else None
        if room:
            room.files[tab_id] = OpenFile(filename=filename, language=language, content=content, path=path)

    def set_workspace_tree(self, code: str, tree: List[dict], truncated: bool = False) -> Optional[Room]:
        """Guarda a árvore do workspace do Host (já validada). Lista vazia =
        Host sem workspace aberto."""
        room = self._rooms.get(code.upper()) if code else None
        if room is None:
            return None
        room.workspace_tree = tree
        room.workspace_tree_truncated = truncated
        return room

    def apply_new_content(self, code: str, tab_id: str, new_content: str) -> None:
        room = self._rooms.get(code.upper()) if code else None
        if room and tab_id in room.files:
            room.files[tab_id].content = new_content

    def set_host_cursor(self, code: str, tab_id: str, line: int) -> None:
        room = self._rooms.get(code.upper()) if code else None
        if room:
            room.host_cursor[tab_id] = line
            # O cursor sempre vem do editor ativo do Host, então a aba dele é a aba em que o Host está.
            room.host_active_tab = tab_id


# Instância única compartilhada por toda a aplicação.
room_manager = RoomManager()
