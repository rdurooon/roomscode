/**
 * Diretório do workspace do Host: botão fixo (ícone de pasta) ao lado das abas
 * que abre um modal com a árvore completa de pastas e arquivos. Só os arquivos
 * que o Host está com aberto nas abas levam a algum lugar; os demais avisam.
 *
 * Os nomes vêm do computador do Host, então tudo aqui é montado com
 * textContent/createElement (nunca innerHTML com dado vindo da rede).
 */
(function () {
    const button = document.getElementById('directory-btn');
    const modal = document.getElementById('directory-modal');
    if (!button || !modal) return;

    const body = document.getElementById('directory-body');
    const truncatedNote = document.getElementById('directory-truncated');
    const closeBtn = document.getElementById('directory-close-btn');

    let tree = [];            // lista de pastas raiz: { name, type, children | blocked }
    let truncated = false;
    let previouslyFocused = null;
    const expandedPaths = new Set(); // pastas abertas pelo usuário (tudo começa fechado, menos a raiz, que é sempre aberta)

    // Ícones fixos do próprio site (nenhum dado externo entra aqui).
    const ICON_FOLDER = '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M2 6C2 4.34315 3.34315 3 5 3H7.75093C8.82997 3 9.86325 3.43595 10.6162 4.20888L9.94852 4.85927L10.6162 4.20888L11.7227 5.34484C11.911 5.53807 12.1693 5.64706 12.4391 5.64706H16.4386C18.5513 5.64706 20.281 7.28495 20.4284 9.35939C21.7878 9.88545 22.5642 11.4588 21.977 12.927L20.1542 17.4853C19.5468 19.0041 18.0759 20 16.4402 20H6C4.88522 20 3.87543 19.5427 3.15116 18.8079C2.44035 18.0867 2 17.0938 2 16V6ZM18.3829 9.17647C18.1713 8.29912 17.3812 7.64706 16.4386 7.64706H12.4391C11.6298 7.64706 10.8548 7.3201 10.2901 6.7404L9.18356 5.60444L9.89987 4.90666L9.18356 5.60444C8.80709 5.21798 8.29045 5 7.75093 5H5C4.44772 5 4 5.44772 4 6V14.4471L5.03813 11.25C5.43958 10.0136 6.59158 9.17647 7.89147 9.17647H18.3829ZM5.03034 17.7499L6.94036 11.8676C7.07417 11.4555 7.45817 11.1765 7.89147 11.1765H19.4376C19.9575 11.1765 20.3131 11.7016 20.12 12.1844L18.2972 16.7426C17.9935 17.502 17.258 18 16.4402 18H6C5.64785 18 5.31756 17.9095 5.03034 17.7499Z" fill="currentColor"></path></svg>';
    const ICON_FILE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>';
    const ICON_LOCK = '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M11 19H5C3.89543 19 3 18.1046 3 17V7C3 5.89543 3.89543 5 5 5H9.58579C9.851 5 10.1054 5.10536 10.2929 5.29289L12 7H19C20.1046 7 21 7.89543 21 9V10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path><rect x="14" y="15" width="7" height="5" rx="1" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></rect><path d="M16 13.5C16 12.6716 16.6716 12 17.5 12V12C18.3284 12 19 12.6716 19 13.5V15H16V13.5Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path></svg>';
    const ICON_CHEVRON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 6 15 12 9 18"></polyline></svg>';

    // ---- Comando de CMD que recria a estrutura (pastas e arquivos vazios) ----

    // Os nomes vêm do computador do Host e o comando é colado no CMD de quem copia, então só entram nomes
    // que são válidos no Windows e inofensivos dentro de aspas no CMD: sem aspas, % e ! (expansão de
    // variáveis), sem caracteres de controle/proibidos, sem nomes reservados e sem "." / "..".
    const CMD_FORBIDDEN_CHARS = /[\u0000-\u001f<>:"|?*%!\\/]/;
    const CMD_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

    function isSafeWindowsName(name) {
        if (typeof name !== 'string' || !name || name === '.' || name === '..') return false;
        if (CMD_FORBIDDEN_CHARS.test(name)) return false;
        if (/[ .]$/.test(name)) return false;
        if (CMD_RESERVED_NAMES.test(name)) return false;
        return true;
    }

    function countNodes(node) {
        let total = 1;
        if (node && Array.isArray(node.children)) node.children.forEach((child) => { total += countNodes(child); });
        return total;
    }

    /**
     * Monta o comando de CMD (uma instrução por linha) que cria a pasta raiz, as subpastas e os arquivos vazios.
     * Cada instrução só age se o item ainda não existe, então rodar de novo nunca sobrescreve nada: pastas
     * existentes são puladas e arquivos existentes mantêm o conteúdo. Pastas bloqueadas (node_modules, .git...)
     * ficam de fora. Devolve { command, skipped }, onde skipped = itens ignorados por nome inválido no Windows.
     */
    function buildCmdCommand(roots) {
        const lines = ['rem RoomsCode - creates these folders and empty files; anything that already exists is left untouched'];
        let skipped = 0;

        function walk(node, relPath) {
            if (node.type === 'dir') {
                if (node.blocked === true) return; // nem a pasta bloqueada é criada
                lines.push(`if not exist "${relPath}\\" md "${relPath}"`);
                (Array.isArray(node.children) ? node.children : []).forEach((child) => {
                    if (!isSafeWindowsName(child.name)) {
                        skipped += countNodes(child);
                        return;
                    }
                    walk(child, `${relPath}\\${child.name}`);
                });
                return;
            }
            lines.push(`if not exist "${relPath}" type nul > "${relPath}"`);
        }

        (Array.isArray(roots) ? roots : []).forEach((root) => {
            if (!isSafeWindowsName(root.name)) {
                skipped += countNodes(root);
                return;
            }
            walk(root, root.name);
        });

        // CRLF e quebra final: o CMD executa cada linha colada, inclusive a última.
        return { command: lines.join('\r\n') + '\r\n', skipped };
    }

    async function copyCommand() {
        const { command, skipped } = buildCmdCommand(tree);
        const ok = window.copyTextToClipboard ? await window.copyTextToClipboard(command) : false;
        if (!window.showToast) return;
        if (!ok) {
            window.showToast(window.t('directory.command_copy_failed'), 'error');
        } else if (skipped > 0) {
            window.showToast(window.t('directory.command_copied_partial', { count: skipped }), 'error');
        } else {
            window.showToast(window.t('directory.command_copied'), 'success');
        }
    }

    function isOpen() {
        return modal.style.display !== 'none';
    }

    function makeSpan(className, svg) {
        const span = document.createElement('span');
        span.className = className;
        span.setAttribute('aria-hidden', 'true');
        span.innerHTML = svg;
        return span;
    }

    function buildNode(node, path, activePath, isRoot) {
        const li = document.createElement('li');
        li.className = 'dir-item';
        li.setAttribute('role', 'treeitem');

        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'dir-row';
        row.dataset.path = path;

        const label = document.createElement('span');
        label.className = 'dir-name';
        label.textContent = node.name;

        if (node.type === 'dir') {
            const blocked = node.blocked === true;
            const children = Array.isArray(node.children) ? node.children : [];
            // A pasta raiz fica sempre aberta e não recolhe (senão o modal encolheria); as demais começam fechadas.
            const expandable = !blocked && !isRoot && children.length > 0;
            const showChildren = !blocked && children.length > 0 && (isRoot || expandedPaths.has(path));

            row.classList.add('dir-row-folder');
            if (blocked) {
                row.classList.add('dir-row-blocked');
                row.title = window.t('directory.blocked_folder');
            }

            if (isRoot) row.classList.add('dir-row-root');
            row.appendChild(makeSpan('dir-chevron' + (expandable ? '' : ' dir-chevron-empty'), ICON_CHEVRON));
            row.appendChild(makeSpan('dir-icon', blocked ? ICON_LOCK : ICON_FOLDER));
            row.appendChild(label);

            if (expandable || isRoot) {
                li.setAttribute('aria-expanded', showChildren ? 'true' : 'false');
                if (showChildren) row.classList.add('dir-row-expanded');
            }

            row.addEventListener('click', () => {
                if (blocked) {
                    if (window.showToast) window.showToast(window.t('directory.blocked_folder'), 'error');
                    return;
                }
                if (!expandable) return;
                if (expandedPaths.has(path)) expandedPaths.delete(path);
                else expandedPaths.add(path);
                render();
                // A renderização recria os botões: devolve o foco à pasta clicada (navegação por teclado).
                const again = Array.from(body.querySelectorAll('.dir-row-folder')).find((el) => el.dataset.path === path);
                if (again) again.focus();
            });
            li.appendChild(row);

            if (showChildren) {
                const ul = document.createElement('ul');
                ul.className = 'dir-children';
                ul.setAttribute('role', 'group');
                children.forEach((child) => ul.appendChild(buildNode(child, `${path}/${child.name}`, activePath, false)));
                li.appendChild(ul);
            }
            return li;
        }

        // Arquivo: só é clicável de verdade se o Host o está com aberto numa aba.
        const tabId = window.getOpenTabIdByPath ? window.getOpenTabIdByPath(path) : null;
        row.classList.add('dir-row-file');
        row.appendChild(makeSpan('dir-chevron dir-chevron-empty', ICON_CHEVRON));
        row.appendChild(makeSpan('dir-icon', ICON_FILE));
        row.appendChild(label);

        if (tabId) {
            row.classList.add('dir-row-open');
            if (activePath && path === activePath) row.classList.add('dir-row-active');
        } else {
            row.classList.add('dir-row-closed');
            row.setAttribute('aria-disabled', 'true');
        }

        row.addEventListener('click', () => {
            // Reconsulta no clique: as abas do Host podem ter mudado desde a última renderização.
            const currentTabId = window.getOpenTabIdByPath ? window.getOpenTabIdByPath(path) : null;
            if (!currentTabId) {
                if (window.showToast) window.showToast(window.t('directory.file_not_open'), 'error');
                return;
            }
            closeModal();
            if (window.openTabFromDirectory) window.openTabFromDirectory(currentTabId);
        });
        li.appendChild(row);
        return li;
    }

    function render() {
        const scrollTop = body.scrollTop;
        body.textContent = '';

        const activePath = window.getActiveTabPath ? window.getActiveTabPath() : null;
        const ul = document.createElement('ul');
        ul.className = 'dir-tree dir-tree-root';
        ul.setAttribute('role', 'tree');
        tree.forEach((root) => ul.appendChild(buildNode(root, root.name, activePath, true)));
        body.appendChild(ul);

        truncatedNote.hidden = !truncated;
        body.scrollTop = scrollTop;
    }

    function openModal() {
        if (!tree.length) return;
        previouslyFocused = document.activeElement;
        render();
        modal.style.display = 'flex';
        if (closeBtn) closeBtn.focus();
    }

    function closeModal() {
        modal.style.display = 'none';
        if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
        previouslyFocused = null;
    }

    /** Atualiza a árvore recebida do servidor; sem workspace (lista vazia), o botão some e o modal fecha. */
    function setWorkspaceTree(newTree, isTruncated) {
        tree = Array.isArray(newTree) ? newTree.filter((root) => root && typeof root.name === 'string') : [];
        truncated = !!isTruncated;

        const hasWorkspace = tree.length > 0;
        button.hidden = !hasWorkspace;

        if (!hasWorkspace) {
            if (isOpen()) closeModal();
            return;
        }
        if (isOpen()) render();
    }

    const terminalBtn = document.getElementById('directory-terminal-btn');
    if (terminalBtn) terminalBtn.addEventListener('click', copyCommand);

    button.addEventListener('click', openModal);
    if (closeBtn) closeBtn.addEventListener('click', closeModal);

    // Clicar no fundo escuro (fora do card) também fecha.
    modal.addEventListener('click', (event) => {
        if (event.target === modal) closeModal();
    });

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && isOpen()) closeModal();
    });

    // Abas abertas/trocadas pelo Host mudam quais arquivos podem ser abertos.
    window.onTabsRendered = () => {
        if (isOpen()) render();
    };

    window.setWorkspaceTree = setWorkspaceTree;

    // Exposto apenas para testes automatizados (jsdom).
    window.__directoryCmd = { buildCmdCommand, isSafeWindowsName };

    window.initWorkspaceTree = (socket) => {
        socket.on('workspace_tree', (data) => {
            setWorkspaceTree(data && data.tree, data && data.truncated);
        });
    };
})();
