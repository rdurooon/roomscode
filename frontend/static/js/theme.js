(function () {
    // Paleta baseada em cores comuns de temas de syntax highlight
    // (tipo Dark+/One Dark): verde, rosa, laranja, azul, amarelo, ciano.
    const palette = [
        { accent: '#4EC9B0', glow: 'rgba(78, 201, 176, 0.24)', line: 'rgba(78, 201, 176, 0.22)' },
        { accent: '#C586C0', glow: 'rgba(197, 134, 192, 0.24)', line: 'rgba(197, 134, 192, 0.22)' },
        { accent: '#CE9178', glow: 'rgba(206, 145, 120, 0.24)', line: 'rgba(206, 145, 120, 0.22)' },
        { accent: '#569CD6', glow: 'rgba(86, 156, 214, 0.24)', line: 'rgba(86, 156, 214, 0.22)' },
        { accent: '#DCDCAA', glow: 'rgba(220, 220, 170, 0.24)', line: 'rgba(220, 220, 170, 0.22)' },
        { accent: '#9CDCFE', glow: 'rgba(156, 220, 254, 0.22)', line: 'rgba(156, 220, 254, 0.20)' },
    ];

    const choice = palette[Math.floor(Math.random() * palette.length)];
    const root = document.documentElement;
    root.style.setProperty('--accent-color', choice.accent);
    root.style.setProperty('--accent-glow', choice.glow);
    root.style.setProperty('--line-highlight-bg', choice.line);
})();
