(function () {
    const COMMANDS = [
        { name: 'code', template: window.t('chat.autocomplete_code_template'), hint: window.t('chat.autocomplete_code_hint') },
        { name: 'user', template: window.t('chat.autocomplete_mention_template'), hint: window.t('chat.autocomplete_mention_hint') },
    ];

    let box = null;
    let currentItems = [];
    let currentOnSelect = null;
    let highlightedIndex = -1;

    function getInput() {
        return document.getElementById('chat-input');
    }

    function ensureBox() {
        if (box) return box;
        box = document.createElement('div');
        box.id = 'chat-suggest-box';
        box.className = 'chat-suggest-box';
        document.body.appendChild(box);
        return box;
    }

    function positionBox() {
        const input = getInput();
        if (!input) return;
        const rect = input.getBoundingClientRect();
        const b = ensureBox();
        b.style.left = `${rect.left}px`;
        b.style.width = `${rect.width}px`;
        b.style.top = `${rect.top - b.offsetHeight - 6}px`;
    }

    function hideBox() {
        if (box) {
            box.style.display = 'none';
        }
        currentItems = [];
        currentOnSelect = null;
        highlightedIndex = -1;
    }

    function updateHighlighted() {
        const b = ensureBox();
        Array.from(b.children).forEach((child, index) => {
            child.classList.toggle('chat-suggest-item-active', index === highlightedIndex);
        });
    }

    function renderItems(items, onSelect) {
        currentItems = items;
        currentOnSelect = onSelect;
        highlightedIndex = items.length ? 0 : -1;

        const b = ensureBox();
        b.innerHTML = '';

        items.forEach((item) => {
            const row = document.createElement('div');
            row.className = 'chat-suggest-item';

            const label = document.createElement('strong');
            label.textContent = item.label;
            row.appendChild(label);

            if (item.hint) {
                const hint = document.createElement('span');
                hint.textContent = item.hint;
                row.appendChild(hint);
            }

            // mousedown (não click) pra não perder o foco do input antes
            // do clique ser processado.
            row.addEventListener('mousedown', (event) => {
                event.preventDefault();
                onSelect(item);
                hideBox();
            });

            b.appendChild(row);
        });

        b.style.display = items.length ? 'block' : 'none';
        updateHighlighted();
        positionBox();
    }

    function applyCommandSuggestion(input, command, matchStart, cursorAtMatchTime) {
        const value = input.value;
        const before = value.slice(0, matchStart);
        const after = value.slice(cursorAtMatchTime);
        const insertion = `!${command.name}(`;

        input.value = before + insertion + after;
        const cursorPos = (before + insertion).length;
        input.setSelectionRange(cursorPos, cursorPos);
        input.focus();
    }

    function applyFileSuggestion(input, filename, argStart, argEnd) {
        const value = input.value;
        const before = value.slice(0, argStart);
        const after = value.slice(argEnd);
        const needsClose = !after.trimStart().startsWith(')');
        const insertion = filename + (needsClose ? ')' : '');

        input.value = before + insertion + after;
        const cursorPos = (before + insertion).length;
        input.setSelectionRange(cursorPos, cursorPos);
        input.focus();
    }

    function applyAtMentionSuggestion(input, name, atIndex, cursorAtMatchTime) {
        const value = input.value;
        const before = value.slice(0, atIndex);
        const after = value.slice(cursorAtMatchTime);
        // Espaço no final delimita onde o nome termina — sem isso, um nome
        // seguido de mais texto sem espaço ficaria ambíguo pra re-detectar
        // a menção depois (ex: ao renderizar a mensagem no chat).
        const insertion = `@${name} `;

        input.value = before + insertion + after;
        const cursorPos = (before + insertion).length;
        input.setSelectionRange(cursorPos, cursorPos);
        input.focus();
    }

    function handleInput() {
        const input = getInput();
        if (!input) return;

        const cursor = input.selectionStart;
        const textBeforeCursor = input.value.slice(0, cursor);

        // Caso 1: usuário está começando um comando ("!" + letras, sem "(" ainda)
        const commandMatch = textBeforeCursor.match(/(^|\s)!([a-zA-Z]*)$/);
        if (commandMatch) {
            const typed = commandMatch[2].toLowerCase();
            const bangIndex = textBeforeCursor.lastIndexOf('!');
            const items = COMMANDS
                .filter((c) => c.name.startsWith(typed))
                .map((c) => ({ label: `!${c.template}`, hint: c.hint, command: c }));

            if (items.length) {
                renderItems(items, (item) => applyCommandSuggestion(input, item.command, bangIndex, cursor));
                return;
            }
        }

        // Caso 2: usuário está digitando o argumento "arquivo" de !code(numero, arquivo)
        const fileArgMatch = textBeforeCursor.match(/!code\(\s*\d+\s*,\s*([^)]*)$/);
        if (fileArgMatch) {
            const typedFile = fileArgMatch[1].trim().toLowerCase();
            const argStart = cursor - fileArgMatch[1].length;
            const tabs = (window.getOpenTabsList && window.getOpenTabsList()) || [];
            const items = tabs
                .filter((t) => t.filename.toLowerCase().includes(typedFile))
                .map((t) => ({ label: t.filename, filename: t.filename }));

            if (items.length) {
                renderItems(items, (item) => applyFileSuggestion(input, item.filename, argStart, cursor));
                return;
            }
        }

        // Caso 3: usuário está digitando o argumento "nome" de !user(nome)
        const userArgMatch = textBeforeCursor.match(/!user\(\s*([^)]*)$/);
        if (userArgMatch) {
            const typedName = userArgMatch[1].trim().toLowerCase();
            const argStart = cursor - userArgMatch[1].length;
            const names = (window.getParticipantNames && window.getParticipantNames()) || [];
            const items = names
                .filter((n) => n.toLowerCase().includes(typedName))
                .map((n) => ({ label: n, filename: n }));

            if (items.length) {
                renderItems(items, (item) => applyFileSuggestion(input, item.filename, argStart, cursor));
                return;
            }
        }

        // Caso 4: usuário está digitando uma menção direta com @
        const atMentionMatch = textBeforeCursor.match(/(^|\s)@(\S*)$/);
        if (atMentionMatch) {
            const typedName = atMentionMatch[2].toLowerCase();
            const atIndex = textBeforeCursor.lastIndexOf('@');
            const names = (window.getParticipantNames && window.getParticipantNames()) || [];
            const items = names
                .filter((n) => n.toLowerCase().startsWith(typedName))
                .map((n) => ({ label: `@${n}`, mentionName: n }));

            if (items.length) {
                renderItems(items, (item) => applyAtMentionSuggestion(input, item.mentionName, atIndex, cursor));
                return;
            }
        }

        hideBox();
    }

    function handleKeydown(event) {
        if (!currentItems.length) return;

        if (event.key === 'ArrowDown') {
            event.preventDefault();
            highlightedIndex = Math.min(highlightedIndex + 1, currentItems.length - 1);
            updateHighlighted();
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            highlightedIndex = Math.max(highlightedIndex - 1, 0);
            updateHighlighted();
        } else if (event.key === 'Enter' || event.key === 'Tab') {
            // Com sugestões abertas, Enter ou Tab escolhem a sugestão em
            // vez de enviar a mensagem / mover o foco.
            event.preventDefault();
            const item = currentItems[highlightedIndex];
            if (item && currentOnSelect) {
                currentOnSelect(item);
            }
            hideBox();
        } else if (event.key === 'Escape') {
            hideBox();
        }
    }

    function init() {
        const input = getInput();
        if (!input) return;

        input.addEventListener('input', handleInput);
        input.addEventListener('keydown', handleKeydown);

        document.addEventListener('mousedown', (event) => {
            if (box && event.target !== input && !box.contains(event.target)) {
                hideBox();
            }
        });

        window.addEventListener('resize', positionBox);
    }

    init();
})();
