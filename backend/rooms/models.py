from dataclasses import dataclass, field
from typing import Dict, Optional, Set


@dataclass
class OpenFile:
    """Representa uma aba/arquivo aberto compartilhado pelo Host."""

    filename: str = ""
    language: str = ""
    content: str = ""
    # Caminho relativo ao workspace (com o nome da pasta raiz na frente), usado
    # para casar a aba com o arquivo correspondente na árvore do diretório.
    path: str = ""


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
    # sid -> id anônimo do navegador do espectador ("" se não enviou). Nunca
    # é enviado a ninguém: só serve pra reconhecer quem volta à sala.
    spectator_client_ids: Dict[str, str] = field(default_factory=dict)
    # sids de espectadores com o chat restrito agora (ver RoomManager.set_chat_muted).
    muted_sids: Set[str] = field(default_factory=set)
    # Restrições que sobrevivem a sair/voltar (F5, expulsão): ids de navegador e
    # nomes normalizados. Quem entrar casando com algum dos dois já entra restrito.
    restricted_client_ids: Set[str] = field(default_factory=set)
    restricted_names: Set[str] = field(default_factory=set)
    files: Dict[str, OpenFile] = field(default_factory=dict)  # tab_id -> OpenFile
    host_cursor: Dict[str, int] = field(default_factory=dict)  # tab_id -> linha atual do host
    # Timestamp (time.monotonic()) de quando o socket do Host caiu, ou None
    # se o Host está conectado agora. Sala em "estado de graça" = host_sid
    # is None e host_disconnected_at is not None; nesse estado a sala
    # continua de pé (ver RoomManager.mark_host_disconnected/reconnect_host).
    host_disconnected_at: Optional[float] = None
    # True enquanto o Host está compartilhando a tela agora. Fica só no
    # servidor porque quem entra depois (ou volta de um F5) precisa saber se
    # há tela pra pedir, e pra não depender de um aviso "único" que o
    # espectador pode ter perdido (ver events/signaling.py).
    screen_sharing: bool = False
    # Árvore do workspace do Host (só nomes; lista de pastas raiz) já validada
    # em events/file_sync.py. Lista vazia = Host fora de um workspace.
    workspace_tree: list = field(default_factory=list)
    workspace_tree_truncated: bool = False
