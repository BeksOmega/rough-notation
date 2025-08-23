export function ensureKeyframes() {
    if (!window.__rno_kf_s) {
        const style = (window.__rno_kf_s =
            document.createElement("style"));
        style.textContent = `
      @keyframes rough-notation-dash { to { stroke-dashoffset: 0; } }
      @keyframes rough-notation-dash-reverse { to { stroke-dashoffset: var(--path-length); } }
    `;
        document.head.appendChild(style);
    }
}
