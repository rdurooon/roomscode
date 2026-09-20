from dataclasses import dataclass, field
from typing import Dict, Optional


@dataclass
class OpenFile:
    """Representa uma aba/arquivo aberto compartilhado pelo Host."""

    filename: str = ""
    language: str = ""
    content: str = ""


@dataclass
class Room:
    """Estado de uma sala ativa, mantido em memória pelo RoomManager."""

    code: str
    host_sid: Optional[str] = None
    host_name: str = ""
    # Token de controle da extensão VS Code — gerado junto com a sala,
    # SEPARADO do código de convite (que é entregue a espectadores e é
    # considerado semi-público). Nunca é enviado a espectadores.
    ext_token: str = ""
    # Token de RECONEXÃO do Host — gerado junto com a sala e devolvido só
    # pra ele (nunca pra espectadores nem pra extensão). Guardado no
    # navegador do Host (sessionStorage) pra provar, depois de uma queda de
    # conexão, que quem está tentando voltar é o mesmo Host que criou a
    # sala — sem ele, qualquer socket poderia tentar assumir uma sala órfã
    # só sabendo o código (que é semi-público).
    host_session_token: str = ""
    # sid do socket da extensão VS Code atualmente anexada a esta sala
    # (None se nenhuma extensão estiver conectada agora).
    extension_sid: Optional[str] = None
    spectators: Dict[str, str] = field(default_factory=dict)  # sid -> nome
    files: Dict[str, OpenFile] = field(default_factory=dict)  # tab_id -> OpenFile
    host_cursor: Dict[str, int] = field(default_factory=dict)  # tab_id -> linha atual do host
    code_visible_to_spectators: bool = False
    # Timestamp (time.monotonic()) de quando o socket do Host caiu, ou None
    # se o Host está conectado agora. Sala em "estado de graça" = host_sid
    # is None e host_disconnected_at is not None; nesse estado a sala
    # continua de pé (ver RoomManager.mark_host_disconnected/reconnect_host).
    host_disconnected_at: Optional[float] = None
