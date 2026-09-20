(function () {
    const handle = document.getElementById('viewer-resize-handle');
    const screenPanel = document.getElementById('screen-panel');
    const codePanel = document.getElementById('code-panel');
    const viewerGrid = document.getElementById('viewer-grid');

    if (!handle || !screenPanel || !codePanel || !viewerGrid) return;

    const MIN_RATIO = 0.2;
    const MAX_RATIO = 0.8;

    let dragging = false;

    function applyRatio(ratio) {
        const clamped = Math.min(Math.max(ratio, MIN_RATIO), MAX_RATIO);
        screenPanel.style.flex = `0 0 ${(clamped * 100).toFixed(2)}%`;
        codePanel.style.flex = `1 1 0%`;
    }

    function handleMove(clientX) {
        const rect = viewerGrid.getBoundingClientRect();
        const handleWidth = handle.getBoundingClientRect().width;
        const usableWidth = rect.width - handleWidth;
        if (usableWidth <= 0) return;

        const ratio = (clientX - rect.left) / usableWidth;
        applyRatio(ratio);
    }

    handle.addEventListener('mousedown', (event) => {
        dragging = true;
        handle.classList.add('dragging');
        document.body.style.userSelect = 'none';
        event.preventDefault();
    });

    document.addEventListener('mousemove', (event) => {
        if (!dragging) return;
        handleMove(event.clientX);
    });

    document.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        handle.classList.remove('dragging');
        document.body.style.userSelect = '';
    });

    // Suporte a toque (tablets/celulares), mesmo comportamento do mouse.
    handle.addEventListener('touchstart', (event) => {
        dragging = true;
        handle.classList.add('dragging');
        event.preventDefault();
    }, { passive: false });

    document.addEventListener('touchmove', (event) => {
        if (!dragging || !event.touches.length) return;
        handleMove(event.touches[0].clientX);
    }, { passive: false });

    document.addEventListener('touchend', () => {
        dragging = false;
        handle.classList.remove('dragging');
    });
})();
