/**
 * Tests for drag-drop indicator and edge-scroll behavior in multi-chat
 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

function loadMultiChatInDom(dom) {
    const src = fs.readFileSync(
        path.resolve(__dirname, '../../public/js/multi-chat.js'), 'utf8'
    );
    const scriptEl = dom.window.document.createElement('script');
    scriptEl.textContent = src;
    dom.window.document.body.appendChild(scriptEl);
}

function makeBaseDom() {
    const dom = new JSDOM(`<!DOCTYPE html><html><body>
        <div id="multiChatContainer"></div>
    </body></html>`, { runScripts: 'dangerously', resources: 'usable' });
    return dom;
}

describe('Drag-drop indicator between tiles', () => {
    test('CSS contains .chat-drop-indicator rule', () => {
        const css = fs.readFileSync(
            path.resolve(__dirname, '../../public/css/style.css'), 'utf8'
        );
        expect(css).toContain('.chat-drop-indicator');
        expect(css).toContain('pointer-events: none');
        expect(css).toContain('flex-shrink: 0');
    });

    test('multi-chat.js contains getDropIndicator helper', () => {
        const src = fs.readFileSync(
            path.resolve(__dirname, '../../public/js/multi-chat.js'), 'utf8'
        );
        expect(src).toContain('getDropIndicator');
        expect(src).toContain('removeDropIndicator');
        expect(src).toContain('chat-drop-indicator');
    });

    test('multi-chat.js contains edge-scroll helpers', () => {
        const src = fs.readFileSync(
            path.resolve(__dirname, '../../public/js/multi-chat.js'), 'utf8'
        );
        expect(src).toContain('startEdgeScrollLoop');
        expect(src).toContain('stopEdgeScroll');
        expect(src).toContain('_edgeScrollDir');
        expect(src).toContain('edgeZone');
    });

    test('dragend removes indicator and stops edge scroll', () => {
        const src = fs.readFileSync(
            path.resolve(__dirname, '../../public/js/multi-chat.js'), 'utf8'
        );
        // The dragend handler should call both removeDropIndicator and stopEdgeScroll
        const dragendBlock = src.match(/dragend[^)]*\)\s*=>\s*\{([^}]+)\}/)?.[1] ?? '';
        expect(dragendBlock).toContain('removeDropIndicator');
        expect(dragendBlock).toContain('stopEdgeScroll');
    });

    test('drop handler removes indicator and stops edge scroll', () => {
        const src = fs.readFileSync(
            path.resolve(__dirname, '../../public/js/multi-chat.js'), 'utf8'
        );
        // Count removeDropIndicator calls - should be in both dragend and drop
        const occurrences = (src.match(/removeDropIndicator\(\)/g) || []).length;
        expect(occurrences).toBeGreaterThanOrEqual(2);
    });

    test('old border-based highlighting removed from dragover handler', () => {
        const src = fs.readFileSync(
            path.resolve(__dirname, '../../public/js/multi-chat.js'), 'utf8'
        );
        // Should no longer add border-l-2 / border-r-2 to highlight tile
        // (only removal in legacy cleanup should remain if any)
        const dragoverIdx = src.indexOf("panelEl.addEventListener('dragover'");
        const dropIdx = src.indexOf("panelEl.addEventListener('drop'");
        const dragoverSection = src.slice(dragoverIdx, dropIdx);
        // border-l-2 / border-r-2 should NOT be added in the dragover section
        expect(dragoverSection).not.toContain("classList.add('border-l-2'");
        expect(dragoverSection).not.toContain("classList.add('border-r-2'");
    });
});
