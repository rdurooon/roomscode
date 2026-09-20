// Cliente mínimo de i18n. Lê o dicionário de traduções já resolvido pro
// idioma do visitante no backend (ver context_processor `inject_i18n` em
// backend/app.py) e embutido na página via <script id="i18n-data">, e
// expõe window.t(key, params) com a mesma semântica de
// backend/i18n/locale.py: chave no formato "namespace.chave", com
// placeholders {nome} interpolados a partir de `params`.
//
// Ao contrário do t() do servidor, aqui não precisa reimplementar fallback
// de idioma incompleto — get_full_translations() no backend já entrega o
// dicionário completo (idioma do visitante mesclado sobre o idioma fonte),
// então qualquer chave existente resolve de primeira.
(function () {
    let translations = {};
    try {
        const dataEl = document.getElementById('i18n-data');
        if (dataEl) {
            translations = JSON.parse(dataEl.textContent);
        }
    } catch (e) {
        console.warn('RoomsCode: falha ao carregar traduções (i18n-data ausente ou inválido).', e);
    }

    function lookup(dottedKey) {
        let value = translations;
        for (const part of dottedKey.split('.')) {
            if (value == null || typeof value !== 'object' || !(part in value)) {
                return null;
            }
            value = value[part];
        }
        return value;
    }

    window.t = function (key, params) {
        const value = lookup(key);
        if (typeof value !== 'string') {
            // Mesmo comportamento do backend pra chave ausente: um
            // marcador visível em vez de quebrar a tela ou mostrar
            // "undefined" — mais fácil de notar durante o desenvolvimento.
            return `[${key}]`;
        }
        if (!params) {
            return value;
        }
        return value.replace(/\{(\w+)\}/g, (match, name) => (
            Object.prototype.hasOwnProperty.call(params, name) ? params[name] : match
        ));
    };

    // Usado pelo seletor de idioma (language-switcher.js) pra trocar o
    // dicionário que window.t() consulta, sem precisar recarregar a página
    // nem recriar esse módulo — qualquer código que chamar window.t()
    // depois de uma troca de idioma já pega o texto certo.
    window.setActiveTranslations = function (newTranslations) {
        translations = newTranslations || {};
    };
})();
