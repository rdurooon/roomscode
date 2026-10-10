from diff_match_patch import diff_match_patch
from flask import current_app, request
from flask_socketio import emit

from ..rooms.manager import room_manager
from .rate_limit import SlidingWindowRateLimiter

dmp = diff_match_patch()

_diff_rate_limiter = SlidingWindowRateLimiter()
_tree_rate_limiter = SlidingWindowRateLimiter()

MAX_TAB_PATH_CHARS = 1000
MAX_TREE_ROOTS = 20


def _clean_path(value) -> str:
    """Caminho relativo ao workspace enviado pela extensão (só serve para casar
    a aba com o arquivo da árvore); qualquer coisa fora do formato vira vazio."""
    if not isinstance(value, str) or len(value) > MAX_TAB_PATH_CHARS:
        return ""
    return value


def _valid_tree_name(name, max_chars: int) -> bool:
    return (
        isinstance(name, str)
        and name not in (".", "..")
        and 0 < len(name) <= max_chars
        and not any(ch in name for ch in ("/", "\\", "\x00"))
    )


def sanitize_workspace_tree(raw, max_nodes: int, max_depth: int, max_name_chars: int):
    """Valida e normaliza a árvore recebida da extensão. Devolve
    (raízes, truncada). Só entram nome, tipo e, para pastas, `blocked` ou
    `children`: qualquer outro campo é descartado, e nenhum conteúdo de
    arquivo passa por aqui. Nós inválidos são ignorados; passar de max_nodes
    ou max_depth corta o resto e marca a árvore como truncada."""
    state = {"count": 0, "truncated": False}

    def walk(node, depth, is_root):
        if not isinstance(node, dict):
            return None
        name = node.get("name")
        if not _valid_tree_name(name, max_name_chars):
            return None
        if state["count"] >= max_nodes:
            state["truncated"] = True
            return None
        state["count"] += 1

        is_dir = is_root or node.get("type") == "dir"
        if not is_dir:
            return {"name": name, "type": "file"}

        result = {"name": name, "type": "dir"}
        if node.get("blocked") is True and not is_root:
            result["blocked"] = True
            return result

        children = node.get("children", [])
        if not isinstance(children, list):
            children = []
        if depth >= max_depth:
            if children:
                state["truncated"] = True
            result["children"] = []
            return result

        clean_children = []
        for child in children:
            clean = walk(child, depth + 1, False)
            if clean is not None:
                clean_children.append(clean)
            if state["truncated"] and state["count"] >= max_nodes:
                break
        result["children"] = clean_children
        return result

    roots = []
    for root in raw[:MAX_TREE_ROOTS]:
        clean = walk(root, 1, True)
        if clean is not None:
            roots.append(clean)
    if len(raw) > MAX_TREE_ROOTS:
        state["truncated"] = True
    return roots, state["truncated"]


def register_file_sync_events(socketio):

    @socketio.on("tabs_full_state")
    def handle_tabs_full_state(data):
        """A extensão manda a lista inteira de abas abertas no VS Code do
        Host — substitui o estado anterior (abas fechadas somem daqui).

        Só é aceito de quem já é um canal confiável da sala (o Host ou a
        extensão VS Code anexada com o token de controle correto — ver
        events/presence.py). Qualquer outro socket (ex.: um espectador ou
        um cliente arbitrário que nunca se autenticou) é ignorado."""
        data = data or {}
        code = data.get("room_code", "")

        if not room_manager.is_trusted_sender(code, request.sid):
            return

        tabs = data.get("tabs", [])
        if not isinstance(tabs, list):
            return

        max_tabs = current_app.config["MAX_TABS_PER_BATCH"]
        max_content = current_app.config["MAX_FILE_CONTENT_CHARS"]
        safe_tabs = [
            tab
            for tab in tabs[:max_tabs]
            if isinstance(tab, dict) and len(str(tab.get("content", ""))) <= max_content
        ]

        for tab in safe_tabs:
            tab["path"] = _clean_path(tab.get("path", ""))

        room = room_manager.set_tabs(code, safe_tabs)
        if room is None:
            return

        emit(
            "tabs_full_state",
            {
                "tabs": [
                    {
                        "tabId": tab.get("tabId"),
                        "filename": tab.get("filename", ""),
                        "language": tab.get("language", ""),
                        "content": tab.get("content", ""),
                        "path": _clean_path(tab.get("path", "")),
                    }
                    for tab in safe_tabs
                ]
            },
            room=room.code,
            include_self=False,
        )

    @socketio.on("file_full_content")
    def handle_file_full_content(data):
        """A extensão manda o conteúdo inteiro de uma aba específica, por
        exemplo ao salvar ou trocar de aba ativa."""
        data = data or {}
        code = data.get("room_code", "")

        if not room_manager.is_trusted_sender(code, request.sid):
            return

        tab_id = data.get("tab_id", "")
        filename = data.get("filename", "")
        language = data.get("language", "")
        content = data.get("content", "")
        path = _clean_path(data.get("path", ""))

        if len(str(content)) > current_app.config["MAX_FILE_CONTENT_CHARS"]:
            # Payload grande demais pra replicar pra sala inteira — descarta
            # em silêncio (a extensão vai mandar o próximo evento normal;
            # não há um jeito seguro de "truncar" código sem correr o risco
            # de exibir algo enganoso pros espectadores).
            return

        room = room_manager.get_room(code)
        if room is None or not tab_id:
            return

        room_manager.update_file(code, tab_id, filename, language, content, path)

        emit(
            "file_full_content",
            {"tabId": tab_id, "filename": filename, "language": language, "content": content, "path": path},
            room=room.code,
            include_self=False,
        )

    @socketio.on("file_diff")
    def handle_file_diff(data):
        """A extensão manda só a diferença de uma aba específica desde a
        última atualização, calculada localmente com diff-match-patch."""
        data = data or {}
        code = data.get("room_code", "")

        if not room_manager.is_trusted_sender(code, request.sid):
            return

        if _diff_rate_limiter.is_limited(
            request.sid,
            current_app.config["FILE_DIFF_RATE_LIMIT_COUNT"],
            current_app.config["FILE_DIFF_RATE_LIMIT_WINDOW_SECONDS"],
        ):
            return

        tab_id = data.get("tab_id", "")
        patch_text = data.get("patch", "")

        if len(str(patch_text)) > current_app.config["MAX_PATCH_CHARS"]:
            return

        room = room_manager.get_room(code)
        if room is None or tab_id not in room.files:
            return

        try:
            patches = dmp.patch_fromText(patch_text)
            new_content, results = dmp.patch_apply(patches, room.files[tab_id].content)
            if not all(results):
                # Alguma parte do patch não aplicou de forma limpa — melhor
                # pedir o estado completo de novo do que arriscar corromper
                # o que os espectadores estão vendo.
                raise ValueError("patch aplicado parcialmente")
            if len(new_content) > current_app.config["MAX_FILE_CONTENT_CHARS"]:
                raise ValueError("conteúdo resultante excede o limite permitido")
            room_manager.apply_new_content(code, tab_id, new_content)
        except Exception:
            emit("request_full_resync", {"tabId": tab_id}, room=room.code)
            return

        emit(
            "file_diff",
            {"tabId": tab_id, "patch": patch_text},
            room=room.code,
            include_self=False,
        )

    @socketio.on("workspace_tree")
    def handle_workspace_tree(data):
        """A extensão manda a árvore de pastas/arquivos (só nomes) do workspace
        do Host, para o botão "Diretório" dos espectadores. Lista vazia ou
        ausente = Host fora de um workspace (o botão some).

        Só é aceito de canal confiável da sala, igual aos eventos de arquivo."""
        data = data or {}
        code = data.get("room_code", "")

        if not room_manager.is_trusted_sender(code, request.sid):
            return

        if _tree_rate_limiter.is_limited(
            request.sid,
            current_app.config["WORKSPACE_TREE_RATE_LIMIT_COUNT"],
            current_app.config["WORKSPACE_TREE_RATE_LIMIT_WINDOW_SECONDS"],
        ):
            return

        raw = data.get("tree") or []
        if not isinstance(raw, list):
            return

        tree, truncated = sanitize_workspace_tree(
            raw,
            current_app.config["MAX_TREE_NODES"],
            current_app.config["MAX_TREE_DEPTH"],
            current_app.config["MAX_TREE_NAME_CHARS"],
        )
        truncated = truncated or data.get("truncated") is True

        room = room_manager.set_workspace_tree(code, tree, truncated)
        if room is None:
            return

        emit(
            "workspace_tree",
            {"tree": tree, "truncated": truncated},
            room=room.code,
            include_self=False,
        )
