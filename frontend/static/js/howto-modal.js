/**
 * Modal "Como usar" da home: abre pelo botão do rodapé, alterna entre o
 * tutorial do Host e o do Espectador e fecha por botão, clique fora ou Esc.
 * O texto em si vem das traduções (ver templates/partials/howto_modal.html).
 */
(function () {
    const modal = document.getElementById('howto-modal');
    const openBtn = document.getElementById('howto-open-btn');
    if (!modal || !openBtn) return;

    const closeBtn = document.getElementById('howto-close-btn');
    const tabs = Array.from(modal.querySelectorAll('[data-howto-tab]'));
    let previouslyFocused = null;

    function selectTab(name) {
        tabs.forEach((tab) => {
            const selected = tab.getAttribute('data-howto-tab') === name;
            tab.setAttribute('aria-selected', selected ? 'true' : 'false');
            const panel = document.getElementById(tab.getAttribute('aria-controls'));
            if (panel) panel.hidden = !selected;
        });
        const body = modal.querySelector('.howto-body');
        if (body) body.scrollTop = 0;
    }

    function openModal() {
        previouslyFocused = document.activeElement;
        selectTab('host');
        modal.style.display = 'flex';
        if (closeBtn) closeBtn.focus();
    }

    function closeModal() {
        modal.style.display = 'none';
        if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
    }

    openBtn.addEventListener('click', openModal);
    if (closeBtn) closeBtn.addEventListener('click', closeModal);
    tabs.forEach((tab) => {
        tab.addEventListener('click', () => selectTab(tab.getAttribute('data-howto-tab')));
    });

    // Clicar no fundo escuro (fora do card) também fecha.
    modal.addEventListener('click', (event) => {
        if (event.target === modal) closeModal();
    });

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && modal.style.display !== 'none') closeModal();
    });
})();
