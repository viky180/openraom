const fs = require('fs');
const path = 'index.html';
let c = fs.readFileSync(path, 'utf8');

// Add menu tip CSS styles
if (!c.includes('.menu-tip-item')) {
  c = c.replace(
    /\s*\.menu-dropdown button \{ width: 100%; text-align: left; \}\r?\n/,
    `    .menu-dropdown button { width: 100%; text-align: left; }\n    .menu-divider {\n      height: 1px;\n      margin: 4px 2px;\n      background: var(--border);\n      opacity: 0.9;\n    }\n    .menu-tip-item {\n      border: 1px solid var(--border);\n      border-radius: 8px;\n      padding: 7px 8px;\n      font-size: 12px;\n      line-height: 1.35;\n      color: var(--muted);\n      background: rgba(10, 14, 22, 0.35);\n    }\n    .menu-tip-item .kbd { margin-right: 6px; }\n`
  );
}

// Add tips in hamburger menu after Delete Page button
if (!c.includes('<div class="menu-tip-item"><span class="kbd">Enter</span>new sibling</div>')) {
  c = c.replace(
    '            <button id="deletePageBtn" class="danger">Delete Page</button>',
    `            <button id="deletePageBtn" class="danger">Delete Page</button>\n            <div class="menu-divider"></div>\n            <div class="menu-tip-item"><span class="kbd">Enter</span>new sibling</div>\n            <div class="menu-tip-item"><span class="kbd">Tab</span>indent</div>\n            <div class="menu-tip-item"><span class="kbd">Shift+Tab</span>outdent</div>\n            <div class="menu-tip-item"><span class="kbd">Backspace on empty</span>delete block</div>\n            <div class="menu-tip-item"><span class="kbd">[[Page]]</span>wiki links</div>\n            <div class="menu-tip-item"><span class="kbd">((blockId))</span>block embed</div>`
  );
}

// Remove old inline helper block from main editor area
c = c.replace(
  /\n\s*<div class="muted" style="margin-bottom:8px;">\n\s*<span class="kbd">Enter<\/span>new sibling[\s\S]*?<\/div>\n\s*<div id="blocks" class="blocks">/m,
  '\n      <div id="blocks" class="blocks">'
);

fs.writeFileSync(path, c, 'utf8');
console.log('patched');
