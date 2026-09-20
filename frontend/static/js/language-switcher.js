// Seletor de idioma manual. Só ativa em páginas que tenham o dropdown
// #lang-switcher E o dicionário de TODOS os idiomas embutido em
// #i18n-all-data (ver i18n_all_json em backend/app.py) — hoje só a home.
// Nas demais páginas este script nem é incluído.
//
// É um dropdown customizado (botão + <ul role="listbox">), não um <select>
// nativo, porque um <select> não consegue renderizar HTML/SVG dentro das
// <option> em nenhum navegador — precisamos das bandeiras como SVG inline.
//
// A troca é 100% no cliente: os 3 idiomas já chegaram prontos na página, só
// percorremos o DOM atualizando quem tem data-i18n/data-i18n-html/
// data-i18n-attr. Ao mesmo tempo grava o cookie roomscode_lang — o mesmo
// que o backend já lê em resolve_locale() — então a escolha feita aqui na
// home vale pro site inteiro: ao navegar pra "Host" ou "Espectador", a sala
// já renderiza no idioma escolhido (o cookie tem prioridade máxima na
// detecção do servidor).
(function () {
    const root = document.getElementById('lang-switcher');
    if (!root) return;

    const trigger = document.getElementById('lang-switcher-trigger');
    const list = document.getElementById('lang-switcher-list');
    const currentFlag = document.getElementById('lang-switcher-current-flag');
    const currentLabel = document.getElementById('lang-switcher-current-label');
    const options = Array.from(list.querySelectorAll('.lang-switcher-option'));

    let allTranslations = {};
    try {
        const dataEl = document.getElementById('i18n-all-data');
        if (dataEl) {
            allTranslations = JSON.parse(dataEl.textContent);
        }
    } catch (e) {
        console.warn('RoomsCode: falha ao carregar traduções de todos os idiomas.', e);
    }

    function lookup(dict, dottedKey) {
        let value = dict;
        for (const part of dottedKey.split('.')) {
            if (value == null || typeof value !== 'object' || !(part in value)) {
                return null;
            }
            value = value[part];
        }
        return value;
    }

    function applyTranslationsToPage(dict) {
        document.querySelectorAll('[data-i18n]').forEach((el) => {
            const value = lookup(dict, el.getAttribute('data-i18n'));
            if (typeof value === 'string') el.textContent = value;
        });

        // Só pra textos de tradução que têm HTML de verdade dentro (ex: os
        // passos do modal de instalação, com <code>...</code>) — o
        // conteúdo vem dos nossos próprios arquivos translations/*.json,
        // nunca de entrada do usuário, então innerHTML aqui é seguro.
        document.querySelectorAll('[data-i18n-html]').forEach((el) => {
            const value = lookup(dict, el.getAttribute('data-i18n-html'));
            if (typeof value === 'string') el.innerHTML = value;
        });

        // Atributos (title, aria-label, placeholder...): formato
        // data-i18n-attr="title:room.foo,aria-label:room.foo" — mais de um
        // atributo pode usar a mesma chave ou chaves diferentes.
        document.querySelectorAll('[data-i18n-attr]').forEach((el) => {
            el.getAttribute('data-i18n-attr').split(',').forEach((pair) => {
                const [attr, key] = pair.split(':').map((s) => s.trim());
                if (!attr || !key) return;
                const value = lookup(dict, key);
                if (typeof value === 'string') el.setAttribute(attr, value);
            });
        });
    }

    function openList() {
        list.hidden = false;
        root.classList.add('open');
        trigger.setAttribute('aria-expanded', 'true');
    }

    function closeList() {
        list.hidden = true;
        root.classList.remove('open');
        trigger.setAttribute('aria-expanded', 'false');
    }

    trigger.addEventListener('click', () => {
        if (list.hidden) {
            openList();
        } else {
            closeList();
        }
    });

    document.addEventListener('click', (event) => {
        if (!root.contains(event.target)) closeList();
    });

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') closeList();
    });

    options.forEach((option) => {
        option.addEventListener('click', () => {
            const locale = option.getAttribute('data-locale');
            const dict = allTranslations[locale];
            closeList();
            if (!dict) return;

            // Clona a bandeira/rótulo já renderizados na opção clicada pro
            // botão — evita duplicar os SVGs em JS, o servidor já mandou
            // tudo pronto no HTML.
            currentFlag.innerHTML = option.querySelector('.lang-flag').innerHTML;
            currentLabel.textContent = option.querySelector('.lang-switcher-option-label').textContent;
            options.forEach((o) => o.setAttribute('aria-selected', o === option ? 'true' : 'false'));

            document.cookie = `roomscode_lang=${locale}; path=/; max-age=31536000; SameSite=Lax`;

            applyTranslationsToPage(dict);
            document.documentElement.lang = locale;
            if (window.setActiveTranslations) {
                window.setActiveTranslations(dict);
            }
        });
    });
})();
