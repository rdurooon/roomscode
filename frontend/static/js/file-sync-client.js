// Estado de todas as abas abertas no VS Code do Host, espelhado aqui.
let openTabs = {};       // tabId -> { filename, language, content, path }
let tabOrder = [];       // ordem de exibição das abas
let activeViewTabId = null; // qual aba o usuário (deste navegador) está vendo agora
let hostCursorByTab = {};   // tabId -> linha atual do host nessa aba
let hostActiveTabId = null; // aba em que o Host está agora (a do último cursor; o servidor também informa na entrada)
let followHostEnabled = false; // modo "seguir o Host" (Espectador)

// ---- Guias de indentação (calculadas por linha) ----

const INDENT_GUIDE_COLOR = 'rgba(255, 255, 255, 0.09)';
const DEFAULT_INDENT_UNIT = 4;
const TAB_SIZE = 4;

/**
 * Largura (em "colunas" de caractere) do espaço em branco no INÍCIO da
 * linha. Tab conta como TAB_SIZE colunas (mesmo comportamento visual de
 * um <pre>); qualquer caractere que não seja espaço/tab encerra a conta.
 */
function leadingIndentWidth(line, tabSize) {
    let width = 0;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === ' ') {
            width += 1;
        } else if (ch === '\t') {
            width += tabSize - (width % tabSize);
        } else {
            break;
        }
    }
    return width;
}

function gcd(a, b) {
    while (b) {
        [a, b] = [b, a % b];
    }
    return a;
}

/** Descobre o "passo" de indentação predominante do arquivo (2, 4, 8...) via MDC das larguras de indentação. */
function detectIndentUnit(lines, tabSize) {
    let result = 0;
    for (const line of lines) {
        if (!line.trim()) continue; // linha em branco não entra na conta
        const width = leadingIndentWidth(line, tabSize);
        if (width > 0) {
            result = result === 0 ? width : gcd(result, width);
        }
    }
    return result >= 2 ? result : DEFAULT_INDENT_UNIT;
}

/**
 * Aplica as guias de indentação SÓ até onde a indentação real de cada
 * linha vai — nunca por cima do texto do código, nunca em linhas sem
 * indentação (ex: `import os`). Cada célula de código (uma por linha,
 * geradas pelo plugin de numeração de linhas) recebe seu próprio
 * background, dimensionado para cobrir exatamente os níveis de
 * indentação daquela linha específica.
 */
function applyIndentGuides(codeEl, content) {
    const rows = codeEl.querySelectorAll('td.hljs-ln-code');
    if (!rows.length) return;

    const lines = content.split('\n');
    const indentUnit = detectIndentUnit(lines, TAB_SIZE);
    const guideImage = `repeating-linear-gradient(to right, ${INDENT_GUIDE_COLOR} 0, ${INDENT_GUIDE_COLOR} 1px, transparent 1px, transparent ${indentUnit}ch)`;

    rows.forEach((cell, index) => {
        const line = lines[index] !== undefined ? lines[index] : (cell.textContent || '');
        const width = leadingIndentWidth(line, TAB_SIZE);
        const levels = Math.floor(width / indentUnit);

        if (levels < 1) {
            cell.style.backgroundImage = 'none';
            return;
        }

        cell.style.backgroundImage = guideImage;
        cell.style.backgroundRepeat = 'no-repeat';
        cell.style.backgroundSize = `${levels * indentUnit}ch 100%`;
    });
}

/**
 * Renderiza o conteúdo com highlight + numeração de linhas.
 *
 * Importante: NÃO usamos hljs.highlightElement() aqui. Essa função marca o
 * elemento como "já destacado" (data-highlighted="yes") e o highlight.js
 * v11 se recusa a rodar de novo nesse mesmo elemento — por isso o destaque
 * só funcionava na primeira vez que o arquivo chegava, e sumia em toda
 * atualização seguinte. Em vez disso, geramos o HTML já destacado via
 * hljs.highlight() e substituímos o innerHTML na mão a cada atualização.
 */
function renderCodePanel(content, language) {
    const codeEl = document.getElementById('code-content');
    codeEl.className = `hljs language-${language || 'plaintext'}`;

    if (window.hljs) {
        try {
            const result = (language && window.hljs.getLanguage(language))
                ? window.hljs.highlight(content, { language, ignoreIllegals: true })
                : window.hljs.highlightAuto(content);
            codeEl.innerHTML = result.value;
        } catch (err) {
            codeEl.textContent = content;
        }

        // Numeração de linhas (plugin à parte). Versão síncrona pra evitar
        // corrida entre atualizações rápidas (diffs). singleLine:true
        // garante numeração mesmo em arquivo de 1 linha só.
        if (window.hljs.lineNumbersBlockSync) {
            window.hljs.lineNumbersBlockSync(codeEl, { singleLine: true });
        } else if (window.hljs.lineNumbersBlock) {
            window.hljs.lineNumbersBlock(codeEl, { singleLine: true });
        }

        applyIndentGuides(codeEl, content);
    } else {
        codeEl.textContent = content;
    }
}

/** Destaca a linha onde o Host está, se a aba exibida for a aba em que ele está agora (com ou sem "Seguir o Host"). */
function highlightHostLine() {
    document.querySelectorAll('.host-line-highlight').forEach((el) => {
        el.classList.remove('host-line-highlight');
    });

    if (!activeViewTabId || activeViewTabId !== hostActiveTabId) return;
    const line = hostCursorByTab[activeViewTabId];
    if (!line) return;

    document.querySelectorAll(`#code-content .hljs-ln-line[data-line-number="${line}"]`).forEach((el) => {
        el.classList.add('host-line-highlight');
    });
}

/**
 * Leva o usuário até uma linha (ou um trecho, de startLine a endLine) do arquivo `filename` (clique numa citação
 * !code(...) do chat): troca pra aba desse arquivo se preciso, rola até a PRIMEIRA linha e destaca por um instante
 * todas as linhas citadas. Devolve false se o arquivo não está mais aberto ou o trecho não existe mais (o chat
 * avisa com um toast).
 */
function goToCodeLine(filename, startLine, endLine) {
    const end = endLine === undefined || endLine === null ? startLine : endLine;
    const tabId = tabOrder.find((id) => openTabs[id] && openTabs[id].filename === filename);
    if (!tabId) return false;

    const lines = openTabs[tabId].content ? openTabs[tabId].content.split('\n') : [];
    if (!Number.isInteger(startLine) || !Number.isInteger(end)) return false;
    if (startLine < 1 || end < startLine || end > lines.length) return false;

    // Troca manual de aba: com "Seguir o Host" ligado ele desliga sozinho
    // (ver switchToTab), senão o próximo movimento do Host puxaria de volta.
    if (tabId !== activeViewTabId) switchToTab(tabId);

    const cells = Array.from(document.querySelectorAll('#code-content .hljs-ln-line')).filter((cell) => {
        const n = parseInt(cell.getAttribute('data-line-number'), 10);
        return n >= startLine && n <= end;
    });
    if (!cells.length) return false;

    cells.forEach((cell) => {
        cell.classList.remove('line-jump-flash');
        void cell.offsetWidth; // reinicia a animação se clicar na mesma linha de novo
        cell.classList.add('line-jump-flash');
    });
    if (cells[0].scrollIntoView) cells[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
    setTimeout(() => cells.forEach((cell) => cell.classList.remove('line-jump-flash')), 2000);
    return true;
}

/** Rola a tela até a linha do Host na aba atual (usado pelo modo seguir). */
function scrollToHostLine() {
    const line = hostCursorByTab[activeViewTabId];
    if (!line) return;

    const rowEl = document.querySelector(`#code-content .hljs-ln-line[data-line-number="${line}"]`);
    if (rowEl && rowEl.scrollIntoView) {
        rowEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
}

/** Ícone de pessoa (vem do <template id="host-tab-icon-template">, que usa partials/host_tab_icon.svg). */
function createHostTabIcon() {
    const icon = document.createElement('span');
    icon.className = 'code-tab-host-icon';
    icon.setAttribute('role', 'img');
    const tooltip = window.t ? window.t('room.host_here_tooltip') : '';
    icon.title = tooltip;
    icon.setAttribute('aria-label', tooltip);

    const template = document.getElementById('host-tab-icon-template');
    if (template && template.content) {
        icon.appendChild(template.content.cloneNode(true));
    }
    return icon;
}

/** Move o ícone do Host para a aba em que ele está agora, sem redesenhar a barra inteira. */
function updateHostTabIndicator() {
    const bar = document.getElementById('code-tab-bar');
    if (!bar) return;

    bar.querySelectorAll('.code-tab').forEach((btn) => {
        const hasIcon = btn.querySelector('.code-tab-host-icon');
        const isHostTab = !!hostActiveTabId && btn.dataset.tabId === hostActiveTabId;
        if (isHostTab && !hasIcon) {
            btn.appendChild(createHostTabIcon());
        } else if (!isHostTab && hasIcon) {
            hasIcon.remove();
        }
    });
}

function renderTabBar() {
    const bar = document.getElementById('code-tab-bar');
    if (!bar) return;

    bar.innerHTML = '';
    tabOrder.forEach((tabId) => {
        const tab = openTabs[tabId];
        if (!tab) return;

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'code-tab' + (tabId === activeViewTabId ? ' code-tab-active' : '');
        btn.dataset.tabId = tabId;

        const label = document.createElement('span');
        label.className = 'code-tab-label';
        label.textContent = tab.filename;
        btn.appendChild(label);

        // O ícone de pessoa fica no lado direito da aba em que o Host está (ver updateHostTabIndicator).
        if (tabId === hostActiveTabId) btn.appendChild(createHostTabIcon());

        btn.addEventListener('click', () => switchToTab(tabId));
        bar.appendChild(btn);
    });

    // Quem mostra o diretório do workspace precisa saber quais arquivos estão abertos/ativos.
    if (window.onTabsRendered) window.onTabsRendered();
}

function switchToTab(tabId, isAutomatic) {
    activeViewTabId = tabId;
    renderTabBar();
    renderActiveTabContent();

    // Se o usuário trocou de aba manualmente enquanto o modo "seguir o
    // Host" estava ligado, desligamos — senão o próximo evento de cursor
    // do Host puxaria de volta, o que seria confuso.
    if (!isAutomatic && followHostEnabled) {
        followHostEnabled = false;
        if (window.onFollowHostAutoDisabled) {
            window.onFollowHostAutoDisabled();
        }
    }
}

function renderActiveTabContent() {
    const filenameEl = document.getElementById('code-filename');
    const tab = openTabs[activeViewTabId];
    const copyBtn = document.getElementById('copy-file-btn');
    const downloadBtn = document.getElementById('download-file-btn');

    if (!tab) {
        filenameEl.textContent = window.t('room.no_file_shared');
        document.getElementById('code-content').innerHTML = '';
        if (copyBtn) copyBtn.disabled = true;
        if (downloadBtn) downloadBtn.disabled = true;
        if (window.setCodeActive) window.setCodeActive(false);
        return;
    }

    filenameEl.textContent = tab.filename;
    renderCodePanel(tab.content, tab.language);
    highlightHostLine();

    if (copyBtn) copyBtn.disabled = false;
    if (downloadBtn) downloadBtn.disabled = false;

    if (window.setCodeActive) window.setCodeActive(true);
}

function upsertTab(tabId, filename, language, content, path) {
    if (!tabId) return;

    const isNew = !(tabId in openTabs);
    openTabs[tabId] = { filename, language, content, path: path || '' };
    if (isNew) {
        tabOrder.push(tabId);
    }
    if (!activeViewTabId) {
        activeViewTabId = tabId; // primeira aba recebida vira a exibida por padrão
    }

    renderTabBar();
    if (tabId === activeViewTabId) {
        renderActiveTabContent();
    }
}

function initFileSync(socket) {
    socket.on('tabs_full_state', (data) => {
        const tabs = data.tabs || [];

        // A extensão (via vscode.window.tabGroups.all) é a fonte da
        // verdade pra ordem das abas — adotamos a ordem recebida por
        // inteiro a cada evento, em vez de tentar mesclar com a ordem
        // antiga (senão uma reordenação no VS Code nunca refletiria aqui).
        const newOpenTabs = {};
        const newOrder = [];
        tabs.forEach((tab) => {
            newOpenTabs[tab.tabId] = {
                filename: tab.filename,
                language: tab.language,
                content: tab.content,
                path: tab.path || '',
            };
            newOrder.push(tab.tabId);
        });

        openTabs = newOpenTabs;
        tabOrder = newOrder;

        if (!activeViewTabId || !openTabs[activeViewTabId]) {
            activeViewTabId = tabOrder[0] || null;
        }

        renderTabBar();
        renderActiveTabContent();
    });

    socket.on('file_full_content', (data) => {
        upsertTab(data.tabId, data.filename, data.language, data.content, data.path);
    });

    socket.on('file_diff', (data) => {
        const tab = openTabs[data.tabId];
        if (!tab) return; // ainda não temos essa aba — o próximo full_state resolve

        if (!window.diff_match_patch) {
            if (window.showToast) {
                window.showToast(window.t('file_sync.diff_apply_failed'), 'error');
            }
            return;
        }

        const dmp = new window.diff_match_patch();
        const patches = dmp.patch_fromText(data.patch);
        const [newContent] = dmp.patch_apply(patches, tab.content);
        tab.content = newContent;

        if (data.tabId === activeViewTabId) {
            renderActiveTabContent();
        }
    });

    socket.on('host_cursor_line', (data) => {
        hostCursorByTab[data.tabId] = data.line;
        const hostTabChanged = hostActiveTabId !== data.tabId;
        hostActiveTabId = data.tabId;
        if (hostTabChanged) updateHostTabIndicator();

        if (followHostEnabled && data.tabId !== activeViewTabId && openTabs[data.tabId]) {
            switchToTab(data.tabId, true);
            scrollToHostLine();
            return;
        }

        // Sempre: a linha nova fica realçada e, se o Host saiu da aba que está sendo vista, o realce antigo some.
        highlightHostLine();
        if (data.tabId === activeViewTabId && followHostEnabled) {
            scrollToHostLine();
        }
    });

    socket.on('request_full_resync', () => {
        console.warn('RoomsCode: fora de sincronia em alguma aba, aguardando reenvio completo do host.');
    });
}

// ---- Funções expostas para o chat e o autocomplete ----

window.getOpenTabsList = () => tabOrder
    .filter((id) => openTabs[id])
    .map((id) => ({ tabId: id, filename: openTabs[id].filename }));

window.getFileLinesForFilename = (filename) => {
    const tabId = tabOrder.find((id) => openTabs[id] && openTabs[id].filename === filename);
    if (!tabId) return null;
    return openTabs[tabId].content ? openTabs[tabId].content.split('\n') : [];
};

window.goToCodeLine = goToCodeLine;

// ---- Usadas pelo diretório do workspace (directory-tree.js) ----

/** Id da aba aberta pelo Host para o arquivo com esse caminho no workspace, ou null se não está aberto. */
window.getOpenTabIdByPath = (path) => {
    if (!path) return null;
    return tabOrder.find((id) => openTabs[id] && openTabs[id].path === path) || null;
};

window.getActiveTabPath = () => (openTabs[activeViewTabId] ? openTabs[activeViewTabId].path : null);

/** Leva o usuário à aba (mesma regra de um clique na aba: com "Seguir o Host" ligado, ele desliga). */
window.openTabFromDirectory = (tabId) => {
    if (!openTabs[tabId]) return false;
    if (tabId !== activeViewTabId) switchToTab(tabId);
    return true;
};

window.getActiveTabFilename = () => (openTabs[activeViewTabId] ? openTabs[activeViewTabId].filename : null);

// ---- Exposto apenas para testes automatizados (jsdom) ----
window.__indentGuides = { leadingIndentWidth, detectIndentUnit, applyIndentGuides };
window.__getSelectedLineRange = getSelectedLineRange;

window.setFollowHost = (enabled) => {
    followHostEnabled = enabled;
    if (!enabled) return;

    // Ao ligar o modo seguir, já pula direto pra onde o Host está agora,
    // em vez de esperar o próximo movimento de cursor dele.
    if (hostActiveTabId && openTabs[hostActiveTabId]) {
        if (hostActiveTabId !== activeViewTabId) {
            switchToTab(hostActiveTabId, true);
        } else {
            highlightHostLine();
        }
        scrollToHostLine();
    }
};

// Usado pelo room-init.js ao processar o payload de `joined_room`.
window.loadInitialTabs = (tabs, hostCursor, hostActiveTab) => {
    tabOrder = [];
    openTabs = {};
    (tabs || []).forEach((tab) => {
        openTabs[tab.tabId] = { filename: tab.filename, language: tab.language, content: tab.content, path: tab.path || '' };
        tabOrder.push(tab.tabId);
    });
    hostCursorByTab = hostCursor || {};
    hostActiveTabId = hostActiveTab || null;
    activeViewTabId = tabOrder[0] || null;
    renderTabBar();
    renderActiveTabContent();
};

/**
 * Primeira e última linha que a seleção cobre de verdade no painel de código (uma linha só ou várias), ou null se
 * não der para saber. Uma linha só conta se a seleção passa por dentro dela: terminar exatamente no começo da linha
 * seguinte (ex.: triplo clique) não inclui essa linha.
 */
function getSelectedLineRange(selection, codeEl) {
    if (!selection || !selection.rangeCount || !codeEl) return null;
    const range = selection.getRangeAt(0);
    const cells = codeEl.querySelectorAll('td.hljs-ln-code');
    if (!cells.length) return null;

    const cellRange = document.createRange();
    let first = null;
    let last = null;
    cells.forEach((cell) => {
        cellRange.selectNodeContents(cell);
        const startsBeforeCellEnds = range.compareBoundaryPoints(Range.END_TO_START, cellRange) < 0;
        const endsAfterCellStarts = range.compareBoundaryPoints(Range.START_TO_END, cellRange) > 0;
        if (!startsBeforeCellEnds || !endsAfterCellStarts) return;

        const n = parseInt(cell.getAttribute('data-line-number'), 10);
        if (!Number.isInteger(n)) return;
        if (first === null || n < first) first = n;
        if (last === null || n > last) last = n;
    });
    return first === null ? null : { start: first, end: last };
}

/**
 * Forma de citar código selecionando um trecho no painel: aparece um botão
 * flutuante que insere `!code(linha, arquivo)` no chat (ou `!code(inicio~fim, arquivo)` quando a seleção pega várias
 * linhas), já preenchendo o arquivo com a aba que está sendo exibida no momento da seleção.
 */
function initLineQuoting() {
    const codeEl = document.getElementById('code-content');
    if (!codeEl) return;

    let citeBtn = null;

    function removeCiteBtn() {
        if (citeBtn) {
            citeBtn.remove();
            citeBtn = null;
        }
    }

    codeEl.addEventListener('mouseup', () => {
        removeCiteBtn();

        // Com o chat restrito pelo Host não dá pra citar linha (copiar/baixar seguem liberados).
        if (window.isChatMuted && window.isChatMuted()) return;

        const tab = openTabs[activeViewTabId];
        if (!tab) return;

        const selection = window.getSelection();
        const selectedText = selection ? selection.toString().trim() : '';
        if (!selectedText || !selection.rangeCount) return;

        let lineRange = getSelectedLineRange(selection, codeEl);
        if (!lineRange) {
            // Sem a estrutura de linhas (ex.: o destaque de sintaxe não carregou): acha o trecho no texto do arquivo.
            const idx = tab.content.indexOf(selectedText);
            if (idx === -1) return;
            const startLine = tab.content.slice(0, idx).split('\n').length;
            lineRange = { start: startLine, end: startLine + selectedText.split('\n').length - 1 };
        }
        const { start: startLine, end: endLine } = lineRange;
        const isRange = endLine > startLine;
        const rect = selection.getRangeAt(0).getBoundingClientRect();

        citeBtn = document.createElement('button');
        citeBtn.type = 'button';
        citeBtn.textContent = isRange
            ? window.t('file_sync.cite_lines_button', { start: startLine, end: endLine })
            : window.t('file_sync.cite_line_button', { line: startLine });
        citeBtn.className = 'cite-line-btn';
        citeBtn.style.top = `${rect.bottom + 6}px`;
        citeBtn.style.left = `${rect.left}px`;

        citeBtn.addEventListener('click', () => {
            const chatInput = document.getElementById('chat-input');
            const needsSpace = chatInput.value && !chatInput.value.endsWith(' ');
            const lineArg = isRange ? `${startLine}~${endLine}` : `${startLine}`;
            chatInput.value += `${needsSpace ? ' ' : ''}!code(${lineArg}, ${tab.filename}) `;
            chatInput.focus();
            removeCiteBtn();
            selection.removeAllRanges();
        });

        document.body.appendChild(citeBtn);
    });

    document.addEventListener('mousedown', (event) => {
        if (citeBtn && event.target !== citeBtn) {
            removeCiteBtn();
        }
    });
}

/** Botões de copiar/baixar o arquivo da aba atualmente exibida. */
function initFileActions() {
    const copyBtn = document.getElementById('copy-file-btn');
    const downloadBtn = document.getElementById('download-file-btn');

    if (copyBtn) {
        copyBtn.addEventListener('click', async () => {
            const tab = openTabs[activeViewTabId];
            if (!tab) return;

            const ok = window.copyTextToClipboard ? await window.copyTextToClipboard(tab.content) : false;
            if (window.showToast) {
                window.showToast(
                    ok ? window.t('file_sync.file_code_copied', { filename: tab.filename }) : window.t('room.room_code_copy_failed'),
                    ok ? 'success' : 'error'
                );
            }
        });
    }

    if (downloadBtn) {
        downloadBtn.addEventListener('click', () => {
            const tab = openTabs[activeViewTabId];
            if (!tab) return;

            const blob = new Blob([tab.content], { type: 'text/plain;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = tab.filename || window.t('file_sync.default_download_filename');
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);

            if (window.showToast) {
                window.showToast(window.t('file_sync.file_downloaded', { filename: tab.filename }), 'success');
            }
        });
    }
}

initLineQuoting();
initFileActions();
