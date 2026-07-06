let db = null;
let SQL = null;

// Initial setup for sql.js
const config = {
    // Specify where to fetch the WebAssembly compiled binary (.wasm)
    locateFile: filename => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/${filename}`
};

// Initialize SQL engine on page load
initSqlJs(config).then(function(sqlModule){
    SQL = sqlModule;
    // Create an empty database in memory by default
    db = new SQL.Database();

    // Create tables
        db.run("CREATE TABLE IF NOT EXISTS entities (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, image TEXT, image_2 TEXT, image_3 TEXT, date TIMESTAMP DEFAULT CURRENT_TIMESTAMP, modified_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);");
    db.run("CREATE TABLE IF NOT EXISTS features (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, factor REAL);");
    db.run("CREATE TABLE IF NOT EXISTS entity_features (entity_id INTEGER, feature_id INTEGER, value TEXT, PRIMARY KEY (entity_id, feature_id));");
    db.run("CREATE TABLE IF NOT EXISTS tags (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, factor REAL, description TEXT);");
    db.run("CREATE TABLE IF NOT EXISTS entity_tags (entity_id INTEGER, tag_id INTEGER, PRIMARY KEY (entity_id, tag_id));");
    db.run("CREATE TABLE IF NOT EXISTS custom_fields (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, description TEXT, type TEXT CHECK(type IN ('text','single_list','multi_list')));");
    db.run("CREATE TABLE IF NOT EXISTS field_options (id INTEGER PRIMARY KEY AUTOINCREMENT, field_id INTEGER REFERENCES custom_fields(id), value TEXT, factor REAL);");
    db.run("CREATE TABLE IF NOT EXISTS entity_field_value (entity_id INTEGER, field_id INTEGER, value TEXT, PRIMARY KEY (entity_id, field_id));");
    db.run("CREATE TABLE IF NOT EXISTS entity_field_value_multi (entity_id INTEGER, field_id INTEGER, option_id INTEGER, PRIMARY KEY (entity_id, field_id, option_id));");
    db.run("CREATE TABLE IF NOT EXISTS configuration (key TEXT PRIMARY KEY, value TEXT);");

    migrateFieldValues();

    // Insert default feature
    const featuresCount = db.exec("SELECT COUNT(*) as cnt FROM features;");
    if (featuresCount.length === 0 || featuresCount[0].values[0][0] === 0) {
        db.run("INSERT INTO features (name, factor) VALUES ('Height', 1.0);");
    }

    // Insert default application name
    const appCfg = db.exec("SELECT value FROM configuration WHERE key = 'app_name';");
    if (appCfg.length === 0 || appCfg[0].values.length === 0) {
        db.run("INSERT INTO configuration (key, value) VALUES ('app_name', 'My App');");
    }

    loadFeatures();
    loadTags();
    loadCustomFields();
    renderFilters();
    updateTable();
    loadConfiguration();
    setTimeout(() => document.body.classList.remove('loading'), 200);
}).catch(err => console.error("Error initializing sql.js:", err));

let sortColumn = null;
let sortAsc = true;
let compactMode = false;
let baseDirHandle = null;
let imagesDirHandle = null;
let uploadImageId = null;
let currentPage = 1;
let pageSize = 100;
let imageNavList = [];
let imageNavIndex = -1;
let manualFilterMode = false;

function showNotification(message, type) {
    const container = document.getElementById('notificationContainer');
    const el = document.createElement('div');
    el.className = 'notification ' + type;
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => {
        el.classList.add('fade-out');
        setTimeout(() => el.remove(), 300);
    }, 3000);
}

// Sidebar toggle
document.getElementById('sidebarToggle').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('open');
});

// Compact mode toggle
document.getElementById('compactToggle').addEventListener('change', function() {
    compactMode = this.checked;
    updateTable();
});

// Clear filter input buttons (delegated)
document.addEventListener('click', function(e) {
    const btn = e.target.closest('.clear-filter-btn');
    if (!btn) return;
    const input = btn.dataset.target ? document.getElementById(btn.dataset.target) : btn.previousElementSibling;
    if (input && input.tagName === 'INPUT') {
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }
});

// Initialize images folder
async function pickImageDir() {
    try {
        baseDirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
        imagesDirHandle = await baseDirHandle.getDirectoryHandle('images', { create: true });
        document.getElementById('dirStatus').textContent = '✅ Folder: ' + baseDirHandle.name + '/images';
        document.getElementById('dirStatus').style.color = '#2ecc71';
    } catch (err) {
        if (err.name !== 'AbortError') {
            alert('Error selecting folder: ' + err.message);
        }
    }
}
document.getElementById('pickDirBtn').addEventListener('click', pickImageDir);

function filterOptions(input) {
    const q = input.value.toLowerCase().trim();
    const container = input.parentElement.nextElementSibling;
    if (!container) return;
    container.querySelectorAll('label').forEach(lbl => {
        const name = lbl.dataset.name || lbl.textContent.toLowerCase();
        lbl.style.display = !q || name.includes(q) ? '' : 'none';
    });
}

function filterFieldOptions(input) {
    const q = input.value.toLowerCase().trim();
    const container = input.parentElement.nextElementSibling;
    if (!container) return;
    const fieldsets = container.querySelectorAll('fieldset');
    if (fieldsets.length > 0) {
        fieldsets.forEach(fs => {
            const labels = fs.querySelectorAll('label[data-optname]');
            let visibleCount = 0;
            labels.forEach(lbl => {
                const name = lbl.dataset.optname || '';
                const match = !q || name.includes(q);
                lbl.style.display = match ? '' : 'none';
                if (match) visibleCount++;
            });
            let noMatch = fs.querySelector('.no-match-msg');
            if (visibleCount === 0) {
                if (!noMatch) {
                    noMatch = document.createElement('div');
                    noMatch.className = 'no-match-msg';
                    noMatch.style.cssText = 'font-size:0.8em;color:#999;padding:2px 0';
                    noMatch.textContent = '(no matching options)';
                    fs.querySelector('div')?.appendChild(noMatch);
                }
            } else if (noMatch) {
                noMatch.remove();
            }
        });
    } else {
        const labels = container.querySelectorAll('label[data-optname]');
        labels.forEach(lbl => {
            const name = lbl.dataset.optname || '';
            lbl.style.display = !q || name.includes(q) ? '' : 'none';
        });
    }
}

// File System Access API: save image
async function saveImageFS(blob, filename) {
    if (!imagesDirHandle) throw new Error('No images folder selected');
    const fileHandle = await imagesDirHandle.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(blob);
    await writable.close();
}

// File System Access API: read image and return URL
async function getImageURL(filename) {
    if (!imagesDirHandle) throw new Error('No images folder selected');
    const fileHandle = await imagesDirHandle.getFileHandle(filename);
    const file = await fileHandle.getFile();
    return URL.createObjectURL(file);
}

// File System Access API: delete image
async function deleteImageFS(filename) {
    if (!imagesDirHandle) return;
    try {
        await imagesDirHandle.removeEntry(filename);
    } catch (_) {}
}

// Handle image upload from input
document.getElementById('imageInput').addEventListener('change', async function(e) {
    const file = e.target.files[0];
    if (!file || uploadImageId === null) return;

    try {
        if (!imagesDirHandle) {
            alert('Please select an images folder in section 2 first.');
            return;
        }

        const stmt = db.prepare("SELECT name, image, image_2, image_3 FROM entities WHERE id = ?");
        stmt.bind([uploadImageId]);
        if (!stmt.step()) {
            alert('Record not found.');
            stmt.free();
            return;
        }
        const row = stmt.getAsObject();
        stmt.free();

        const currentName = row.name;

        const ext = file.name.split('.').pop() || 'png';
        const randomId = Math.random().toString(36).substring(2, 10);
        const filename = `${currentName}_${randomId}.${ext}`;
        const blob = new Blob([await file.arrayBuffer()], { type: file.type });

        await saveImageFS(blob, filename);

        let col;
        let oldFile = null;
        if (!row.image) {
            col = 'image';
        } else if (!row.image_2) {
            col = 'image_2';
        } else {
            col = 'image_3';
            if (row.image_3) oldFile = row.image_3;
        }
        if (oldFile) await deleteImageFS(oldFile);
        db.run(`UPDATE entities SET ${col} = ?, modified_at = CURRENT_TIMESTAMP WHERE id = ?;`, [filename, uploadImageId]);
        updateTable();
        showNotification('Entity "' + currentName + '" image updated', 'warning');
    } catch (err) {
        alert('Error uploading image: ' + err.message);
    }

    uploadImageId = null;
    e.target.value = '';
});

// Close image modal
document.getElementById('closeModalBtn').addEventListener('click', () => {
    document.getElementById('imageModal').style.display = 'none';
});


function showImageModalByIndex(idx) {
    const item = imageNavList[idx];
    if (!item) return;
    imageNavIndex = idx;
    document.getElementById('modalEntityName').textContent = item.name;
    document.getElementById('imageModal').style.display = 'flex';

    const modalImg = document.getElementById('modalImage');
    const thumbContainer = document.getElementById('modalThumbnails');
    thumbContainer.innerHTML = '';

    function setActiveImage(index) {
        if (!item.files[index]) return;
        (async () => {
            try {
                const url = await getImageURL(item.files[index]);
                modalImg.src = url;
                thumbContainer.querySelectorAll('.modal-thumb').forEach((t, i) => {
                    t.classList.toggle('active', i === index);
                });
            } catch (err) {
                alert('Error loading image: ' + err.message);
            }
        })();
    }

    item.files.forEach((file, i) => {
        const thumb = document.createElement('img');
        thumb.className = 'modal-thumb' + (i === 0 ? ' active' : '');
        thumb.addEventListener('click', () => setActiveImage(i));
        thumbContainer.appendChild(thumb);
        (async () => {
            try {
                thumb.src = await getImageURL(file);
            } catch (_) {}
        })();
    });

    setActiveImage(0);
}

document.getElementById('prevImageBtn').addEventListener('click', () => {
    if (imageNavList.length === 0) return;
    imageNavIndex = (imageNavIndex - 1 + imageNavList.length) % imageNavList.length;
    showImageModalByIndex(imageNavIndex);
});

document.getElementById('nextImageBtn').addEventListener('click', () => {
    if (imageNavList.length === 0) return;
    imageNavIndex = (imageNavIndex + 1) % imageNavList.length;
    showImageModalByIndex(imageNavIndex);
});

document.getElementById('randomImageBtn').addEventListener('click', () => {
    if (imageNavList.length === 0) return;
    imageNavIndex = Math.floor(Math.random() * imageNavList.length);
    showImageModalByIndex(imageNavIndex);
});

document.addEventListener('keydown', (e) => {
    if (document.getElementById('imageModal').style.display !== 'flex') return;
    if (e.key === 'ArrowLeft') {
        e.preventDefault();
        document.getElementById('prevImageBtn').click();
    } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        document.getElementById('nextImageBtn').click();
    }
});

// CRUD Features
let featuresList = [];

function loadFeatures() {
    const res = db.exec("SELECT id, name, factor FROM features ORDER BY id;");
    featuresList = [];
    if (res.length > 0) {
        featuresList = res[0].values.map(f => ({ id: f[0], name: f[1], factor: f[2] }));
    }
    renderFeatures();
    renderFeatureInputs();
    if (document.getElementById('filterContainer')) renderFilters();
}

function renderFeatures() {
    const tbody = document.getElementById('featuresTableBody');
    tbody.innerHTML = '';
    featuresList.forEach(c => {
        const tr = document.createElement('tr');
        tr.dataset.id = c.id;
        tr.innerHTML = `<td class="feature-name">${c.name}</td><td class="feature-factor">${c.factor !== null ? c.factor : '-'}</td>
            <td><button class="edit-feature-btn" style="padding:2px 6px;font-size:0.85em">✏️</button>
            <button class="del-feature-btn" style="padding:2px 6px;font-size:0.85em;background-color:#e74c3c;">✖</button></td>`;
        tbody.appendChild(tr);
    });
    document.querySelectorAll('.edit-feature-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const tr = btn.closest('tr');
            const id = parseInt(tr.dataset.id);
            const nameTd = tr.querySelector('.feature-name');
            const factorTd = tr.querySelector('.feature-factor');
            if (btn.textContent === '✏️') {
                const curName = nameTd.textContent;
                const curFactor = factorTd.textContent === '-' ? '' : factorTd.textContent;
                nameTd.innerHTML = `<input type="text" class="feature-edit-name" value="${curName}" style="width:90%">`;
                factorTd.innerHTML = `<input type="number" class="feature-edit-factor" value="${curFactor}" step="0.01" style="width:70px">`;
                btn.textContent = '💾';
            } else {
                const newName = nameTd.querySelector('.feature-edit-name').value.trim();
                const newFactor = factorTd.querySelector('.feature-edit-factor').value.trim();
                if (!newName) { alert('Name is required.'); return; }
                db.run("UPDATE features SET name = ?, factor = ? WHERE id = ?;",
                    [newName, newFactor ? parseFloat(newFactor) : null, id]);
                loadFeatures();
                updateTable();
                showNotification('Feature "' + newName + '" updated', 'warning');
            }
        });
    });
    document.querySelectorAll('.del-feature-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            if (!confirm('Delete this feature?')) return;
            const tr = btn.closest('tr');
            const name = tr.querySelector('.feature-name').textContent;
            const id = parseInt(tr.dataset.id);
            db.run("DELETE FROM entity_features WHERE feature_id = ?;", [id]);
            db.run("DELETE FROM features WHERE id = ?;", [id]);
            loadFeatures();
            updateTable();
            showNotification('Feature "' + name + '" deleted', 'error');
        });
    });
}

function renderFeatureInputs(selectedValues = {}) {
    const container = document.getElementById('featureInputsContainer');
    container.innerHTML = '';
    if (featuresList.length === 0) {
        container.innerHTML = '<em>No features defined.</em>';
        return;
    }
    const grades = ['F', 'E', 'D', 'C', 'B', 'A', 'S'];
    let html = '<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center">';
    featuresList.forEach(c => {
        const val = selectedValues[c.id] || 'D';
        html += `<label class="feature-item">${c.name}:
            <select class="feature-select" data-feature-id="${c.id}">
                ${grades.map(g => `<option value="${g}" ${g === val ? 'selected' : ''}>${g}</option>`).join('')}
            </select>
        </label>`;
    });
    html += '</div>';
    container.innerHTML = html;
}

// Features Modal
document.getElementById('manageFeaturesBtn').addEventListener('click', () => {
    document.getElementById('featuresModal').style.display = 'flex';
});
document.getElementById('closeFeaturesBtn').addEventListener('click', () => {
    document.getElementById('featuresModal').style.display = 'none';
    loadFeatures();
    updateTable();
});

document.getElementById('addFeatureBtn').addEventListener('click', () => {
    const name = document.getElementById('newFeatureFieldName').value.trim();
    const factor = document.getElementById('newFeatureFactor').value.trim();
    if (!name) { alert('Name is required.'); return; }
    try {
        db.run("INSERT INTO features (name, factor) VALUES (?, ?);", [name, factor ? parseFloat(factor) : null]);
        document.getElementById('newFeatureFieldName').value = '';
        document.getElementById('newFeatureFactor').value = '';
        loadFeatures();
        showNotification('Feature "' + name + '" created', 'success');
    } catch (e) {
        alert('Error: ' + e.message);
    }
});

function getFeatureValues() {
    const selects = document.querySelectorAll('#featureInputsContainer .feature-select');
    const values = {};
    selects.forEach(sel => {
        values[parseInt(sel.dataset.featureId)] = sel.value;
    });
    return values;
}

function saveEntityFeatures(entityId, values) {
    for (const [featureId, value] of Object.entries(values)) {
        db.run(`INSERT OR REPLACE INTO entity_features (entity_id, feature_id, value) VALUES (?, ?, ?);`,
            [entityId, parseInt(featureId), value]);
    }
}

// CRUD Tags
let tagsList = [];

function loadTags() {
    const res = db.exec("SELECT id, name, factor, description FROM tags ORDER BY id;");
    tagsList = [];
    if (res.length > 0) {
        tagsList = res[0].values.map(f => ({ id: f[0], name: f[1], factor: f[2], description: f[3] }));
    }
    renderTags();
    renderTagCheckboxes();
    if (document.getElementById('filterContainer')) renderFilters();
}

function renderTags() {
    const tbody = document.getElementById('tagsTableBody');
    tbody.innerHTML = '';
    tagsList.forEach(e => {
        const tr = document.createElement('tr');
        tr.dataset.id = e.id;
        tr.innerHTML = `<td class="tag-name">${e.name}</td><td class="tag-factor">${e.factor !== null ? e.factor : '-'}</td>
            <td class="tag-desc">${e.description || ''}</td>
            <td><button class="edit-tag-btn" style="padding:2px 6px;font-size:0.85em">✏️</button>
            <button class="del-tag-btn" style="padding:2px 6px;font-size:0.85em;background-color:#e74c3c;">✖</button></td>`;
        tbody.appendChild(tr);
    });
    document.querySelectorAll('.edit-tag-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const tr = btn.closest('tr');
            const id = parseInt(tr.dataset.id);
            const nameTd = tr.querySelector('.tag-name');
            const factorTd = tr.querySelector('.tag-factor');
            const descTd = tr.querySelector('.tag-desc');
            if (btn.textContent === '✏️') {
                nameTd.innerHTML = `<input type="text" class="tag-edit-name" value="${nameTd.textContent}" style="width:90%">`;
                factorTd.innerHTML = `<input type="number" class="tag-edit-factor" value="${factorTd.textContent === '-' ? '' : factorTd.textContent}" step="0.01" style="width:70px">`;
                descTd.innerHTML = `<input type="text" class="tag-edit-desc" value="${descTd.textContent}" style="width:90%">`;
                btn.textContent = '💾';
            } else {
                const newName = nameTd.querySelector('.tag-edit-name').value.trim().toUpperCase();
                const newFactor = factorTd.querySelector('.tag-edit-factor').value.trim();
                const newDesc = descTd.querySelector('.tag-edit-desc').value.trim();
                if (!newName) { alert('Name is required.'); return; }
                if (!/^[A-Z0-9_]+$/.test(newName)) {
                    alert('Only uppercase letters, numbers and underscores are allowed.');
                    return;
                }
                db.run("UPDATE tags SET name = ?, factor = ?, description = ? WHERE id = ?;",
                    [newName, newFactor ? parseFloat(newFactor) : null, newDesc || null, id]);
                loadTags();
                updateTable();
                showNotification('Tag "' + newName + '" updated', 'warning');
            }
        });
    });
    document.querySelectorAll('.del-tag-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            if (!confirm('Delete this tag?')) return;
            const tr = btn.closest('tr');
            const name = tr.querySelector('.tag-name').textContent;
            const id = parseInt(tr.dataset.id);
            db.run("DELETE FROM entity_tags WHERE tag_id = ?;", [id]);
            db.run("DELETE FROM tags WHERE id = ?;", [id]);
            loadTags();
            updateTable();
            showNotification('Tag "' + name + '" deleted', 'error');
        });
    });
}

function renderTagCheckboxes(selectedIds = []) {
    const container = document.getElementById('tagInputsContainer');
    container.innerHTML = '';
    if (tagsList.length === 0) {
        container.innerHTML = '<em>No tags defined.</em>';
        return;
    }
    const sorted = [...tagsList].sort((a, b) => a.name.localeCompare(b.name));
    let html = '<div style="display:flex;align-items:center;gap:4px">' +
        '<input type="text" class="filter-input" placeholder="Filter tags..." oninput="filterOptions(this)" style="flex:1">' +
        '<button class="clear-filter-btn" style="padding:2px 6px;font-size:0.8em;background:#585b70;color:#e0e0e0;margin:0">✖</button></div>';
    html += '<div class="filterable-list compact">';
    sorted.forEach(e => {
        const checked = selectedIds.includes(e.id) ? 'checked' : '';
        html += `<label class="tag-check" data-name="${(e.name + ' ' + (e.description || '')).toLowerCase()}">
            <input type="checkbox" class="tag-checkbox" data-tag-id="${e.id}" ${checked}>
            ${e.description || e.name}
        </label>`;
    });
    html += '</div>';
    container.innerHTML = html;
}

// Tags Modal
document.getElementById('manageTagsBtn').addEventListener('click', () => {
    document.getElementById('tagsModal').style.display = 'flex';
});
document.getElementById('closeTagsBtn').addEventListener('click', () => {
    document.getElementById('tagsModal').style.display = 'none';
    loadTags();
    updateTable();
});

document.getElementById('addTagBtn').addEventListener('click', () => {
    const name = document.getElementById('newTagFieldName').value.trim().toUpperCase();
    const factor = document.getElementById('newTagFactor').value.trim();
    const description = document.getElementById('newTagDesc').value.trim();
    if (!name) { alert('Name is required.'); return; }
    if (!/^[A-Z0-9_]+$/.test(name)) {
        alert('Only uppercase letters, numbers and underscores are allowed.');
        return;
    }
    try {
        db.run("INSERT INTO tags (name, factor, description) VALUES (?, ?, ?);", [name, factor ? parseFloat(factor) : null, description || null]);
        document.getElementById('newTagFieldName').value = '';
        document.getElementById('newTagFactor').value = '';
        document.getElementById('newTagDesc').value = '';
        loadTags();
        showNotification('Tag "' + name + '" created', 'success');
    } catch (e) {
        alert('Error: ' + e.message);
    }
});

function getSelectedTagIds() {
    const checks = document.querySelectorAll('#tagInputsContainer .tag-checkbox:checked');
    return Array.from(checks).map(c => parseInt(c.dataset.tagId));
}

function saveEntityTags(entityId, tagIds) {
    db.run("DELETE FROM entity_tags WHERE entity_id = ?;", [entityId]);
    tagIds.forEach(eid => {
        db.run("INSERT INTO entity_tags (entity_id, tag_id) VALUES (?, ?);", [entityId, eid]);
    });
}

// CRUD Custom Fields
let customFieldsList = [];
let editingFieldOptionsId = null;

function loadCustomFields() {
    const res = db.exec("SELECT id, name, description, type FROM custom_fields ORDER BY id;");
    customFieldsList = [];
    if (res.length > 0) {
        customFieldsList = res[0].values.map(r => ({ id: r[0], name: r[1], description: r[2], type: r[3] }));
    }
    renderCustomFields();
    renderFieldInputs();
    if (document.getElementById('filterContainer')) renderFilters();
}

function getFieldOptions(fieldId) {
    const res = db.exec("SELECT id, value, factor FROM field_options WHERE field_id = ? ORDER BY value;", [fieldId]);
    if (res.length === 0) return [];
    return res[0].values.map(r => ({ id: r[0], value: r[1], factor: r[2] }));
}

function renderCustomFields() {
    const tbody = document.getElementById('fieldsTableBody');
    tbody.innerHTML = '';
    customFieldsList.forEach(c => {
        const isList = c.type === 'single_list' || c.type === 'multi_list';
        let typeLabel = { text: 'Text', single_list: 'List (single)', multi_list: 'List (multiple)' }[c.type] || c.type;
        const tr = document.createElement('tr');
        tr.dataset.id = c.id;
        tr.innerHTML = `<td class="field-name">${c.name}</td><td class="field-desc">${c.description || ''}</td><td class="field-type">${typeLabel}</td>
            <td>${isList ? `<button class="opt-field-btn" style="padding:2px 6px;font-size:0.85em">📋 Options</button>` : '—'}</td>
            <td><button class="edit-field-btn" style="padding:2px 6px;font-size:0.85em">✏️</button>
            <button class="del-field-btn" style="padding:2px 6px;font-size:0.85em;background-color:#e74c3c;">✖</button></td>`;
        tbody.appendChild(tr);
    });
    document.querySelectorAll('.edit-field-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const tr = btn.closest('tr');
            const id = parseInt(tr.dataset.id);
            const nameTd = tr.querySelector('.field-name');
            const descTd = tr.querySelector('.field-desc');
            if (btn.textContent === '✏️') {
                nameTd.innerHTML = `<input type="text" class="field-edit-name" value="${nameTd.textContent}" style="width:90%">`;
                descTd.innerHTML = `<input type="text" class="field-edit-desc" value="${descTd.textContent}" style="width:90%">`;
                btn.textContent = '💾';
            } else {
                const newName = nameTd.querySelector('.field-edit-name').value.trim();
                const newDesc = descTd.querySelector('.field-edit-desc').value.trim();
                if (!newName) { alert('Name is required.'); return; }
                db.run("UPDATE custom_fields SET name = ?, description = ? WHERE id = ?;",
                    [newName, newDesc || null, id]);
                loadCustomFields();
                updateTable();
                showNotification('Custom field "' + newName + '" updated', 'warning');
            }
        });
    });
    document.querySelectorAll('.del-field-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            if (!confirm('Delete this field? Connected choices and values will also be deleted.')) return;
            const tr = btn.closest('tr');
            const name = tr.querySelector('.field-name').textContent;
            const id = parseInt(tr.dataset.id);
            db.run("DELETE FROM entity_field_value WHERE field_id = ?;", [id]);
            db.run("DELETE FROM entity_field_value_multi WHERE field_id = ?;", [id]);
            db.run("DELETE FROM field_options WHERE field_id = ?;", [id]);
            db.run("DELETE FROM custom_fields WHERE id = ?;", [id]);
            loadCustomFields();
            updateTable();
            showNotification('Custom field "' + name + '" deleted', 'error');
        });
    });
    document.querySelectorAll('.opt-field-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const id = parseInt(btn.closest('tr').dataset.id);
            showFieldOptions(id);
        });
    });
}

function showFieldOptions(fieldId) {
    editingFieldOptionsId = fieldId;
    const container = document.getElementById('fieldOptionsContainer');
    const content = document.getElementById('fieldOptionsContent');
    container.style.display = 'block';
    const opts = getFieldOptions(fieldId);
    let html = '<table style="width:100%;margin-bottom:4px"><thead><tr><th>Value</th><th>Factor</th><th></th></tr></thead><tbody>';
    opts.forEach(o => {
        html += `<tr data-id="${o.id}"><td class="opt-val">${o.value}</td><td class="opt-factor">${o.factor !== null ? o.factor : '-'}</td>
            <td><button class="edit-opt-btn" style="padding:1px 5px;font-size:0.8em">✏️</button>
            <button class="del-opt-btn" style="padding:1px 5px;font-size:0.8em;background-color:#e74c3c;">✖</button></td></tr>`;
    });
    html += '</tbody></table>';
    html += `<div style="display:flex;gap:4px;flex-wrap:wrap">
        <input type="text" id="newOptValue" placeholder="Value" style="flex:2">
        <input type="number" id="newOptFactor" placeholder="Factor" step="0.01" style="flex:1">
        <button id="addOptBtn" style="padding:4px 10px;font-size:0.85em">➕ Add Option</button>
    </div>`;
    content.innerHTML = html;

    document.getElementById('addOptBtn').addEventListener('click', () => {
        const value = document.getElementById('newOptValue').value.trim();
        const factor = document.getElementById('newOptFactor').value.trim();
        if (!value) { alert('Value is required.'); return; }
        db.run("INSERT INTO field_options (field_id, value, factor) VALUES (?, ?, ?);",
            [editingFieldOptionsId, value, factor ? parseFloat(factor) : null]);
        document.getElementById('newOptValue').value = '';
        document.getElementById('newOptFactor').value = '';
        showFieldOptions(editingFieldOptionsId);
        loadCustomFields();
        showNotification('Option "' + value + '" created', 'success');
    });

    document.querySelectorAll('.edit-opt-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const tr = btn.closest('tr');
            const id = parseInt(tr.dataset.id);
            const valTd = tr.querySelector('.opt-val');
            const factorTd = tr.querySelector('.opt-factor');
            if (btn.textContent === '✏️') {
                valTd.innerHTML = `<input type="text" class="opt-edit-val" value="${valTd.textContent}" style="width:90%">`;
                factorTd.innerHTML = `<input type="number" class="opt-edit-factor" value="${factorTd.textContent === '-' ? '' : factorTd.textContent}" step="0.01" style="width:70px">`;
                btn.textContent = '💾';
            } else {
                const newVal = valTd.querySelector('.opt-edit-val').value.trim();
                const newFactor = factorTd.querySelector('.opt-edit-factor').value.trim();
                if (!newVal) { alert('Value is required.'); return; }
                db.run("UPDATE field_options SET value = ?, factor = ? WHERE id = ?;",
                    [newVal, newFactor ? parseFloat(newFactor) : null, id]);
                showFieldOptions(editingFieldOptionsId);
                loadCustomFields();
                showNotification('Option "' + newVal + '" updated', 'warning');
            }
        });
    });

    document.querySelectorAll('.del-opt-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const tr = btn.closest('tr');
            const val = tr.querySelector('.opt-val').textContent;
            const id = parseInt(tr.dataset.id);
            db.run("DELETE FROM field_options WHERE id = ?;", [id]);
            showFieldOptions(editingFieldOptionsId);
            loadCustomFields();
            showNotification('Option "' + val + '" deleted', 'error');
        });
    });
}

function renderFieldInputs(savedValues = {}) {
    const container = document.getElementById('fieldInputsContainer');
    container.innerHTML = '';
    if (customFieldsList.length === 0) return;
    let html = '<div style="display:flex;align-items:center;gap:4px">' +
        '<input type="text" class="filter-input" placeholder="Filter option values..." oninput="filterFieldOptions(this)" style="flex:1">' +
        '<button class="clear-filter-btn" style="padding:2px 6px;font-size:0.8em;background:#585b70;color:#e0e0e0;margin:0">✖</button></div>';
    html += '<div class="filterable-list">';
    [...customFieldsList].sort((a, b) => a.name.localeCompare(b.name)).forEach(c => {
        if (c.type === 'text') {
            const val = savedValues[c.id] || '';
            html += `<label style="display:flex;flex-direction:column;gap:2px;font-size:0.9em;margin-bottom:6px">
                ${c.name} <input type="text" class="field-input-text" data-field-id="${c.id}" value="${val}" style="padding:2px 6px">
            </label>`;
        } else {
            const opts = getFieldOptions(c.id);
            const isMulti = c.type === 'multi_list';
            const saved = savedValues[c.id] ? (Array.isArray(savedValues[c.id]) ? savedValues[c.id] : String(savedValues[c.id]).split(',').filter(Boolean)) : [];
            html += `<fieldset style="border:1px solid #45475a;border-radius:4px;padding:4px 8px;margin:0 0 6px 0">
                <legend style="font-size:0.85em">${c.name} ${isMulti ? '(multiple)' : ''}</legend>
                <div style="display:flex;flex-wrap:wrap;gap:4px">`;
            opts.forEach(o => {
                const oid = String(o.id);
                if (isMulti) {
                    const checked = saved.includes(oid) ? 'checked' : '';
                    html += `<label data-optname="${o.value.toLowerCase()}" style="font-size:0.85em;white-space:nowrap">
                        <input type="checkbox" class="field-input-chk" data-field-id="${c.id}" data-opt-id="${o.id}" ${checked}> ${o.value}
                    </label>`;
                } else {
                    const selected = saved.includes(oid) ? 'selected' : '';
                    html += `<label data-optname="${o.value.toLowerCase()}" style="font-size:0.85em;white-space:nowrap">
                        <input type="radio" class="field-input-radio" name="field_radio_${c.id}" data-field-id="${c.id}" data-opt-id="${o.id}" ${selected ? 'checked' : ''}> ${o.value}
                    </label>`;
                }
            });
            if (!isMulti && opts.length > 0) {
                const hasChecked = opts.some(o => saved.includes(String(o.id)));
                if (!hasChecked) {
                    html += `<label data-optname="(none)" style="font-size:0.85em;white-space:nowrap;color:#6c7086">
                        <input type="radio" class="field-input-radio" name="field_radio_${c.id}" data-field-id="${c.id}" data-opt-id="" checked> (none)
                    </label>`;
                }
            }
            html += '</div></fieldset>';
        }
    });
    html += '</div>';
    container.innerHTML = html;
}

function migrateFieldValues() {
    const stmt = db.prepare("INSERT OR IGNORE INTO entity_field_value_multi (entity_id, field_id, option_id) VALUES (?, ?, ?);");
    // Migrate single_list values from entity_field_value to entity_field_value_multi
    const singleRes = db.exec(`
        SELECT efv.entity_id, efv.field_id, efv.value
        FROM entity_field_value efv
        JOIN custom_fields cf ON efv.field_id = cf.id
        WHERE cf.type = 'single_list' AND efv.value IS NOT NULL AND efv.value != '';
    `);
    if (singleRes.length > 0 && singleRes[0].values.length > 0) {
        singleRes[0].values.forEach(r => {
            const eid = r[0], fid = r[1], val = String(r[2]);
            const optId = parseInt(val.trim());
            if (!isNaN(optId)) {
                stmt.bind([eid, fid, optId]);
                stmt.step();
                stmt.reset();
            }
        });
        db.run("DELETE FROM entity_field_value WHERE field_id IN (SELECT id FROM custom_fields WHERE type = 'single_list');");
    }
    // Migrate multi_list values from entity_field_value to entity_field_value_multi
    const multiRes = db.exec(`
        SELECT efv.entity_id, efv.field_id, efv.value
        FROM entity_field_value efv
        JOIN custom_fields cf ON efv.field_id = cf.id
        WHERE cf.type = 'multi_list' AND efv.value IS NOT NULL AND efv.value != '';
    `);
    if (multiRes.length > 0 && multiRes[0].values.length > 0) {
        multiRes[0].values.forEach(r => {
            const eid = r[0], fid = r[1], val = String(r[2]);
            val.split(',').forEach(s => {
                const optId = parseInt(s.trim());
                if (!isNaN(optId)) {
                    stmt.bind([eid, fid, optId]);
                    stmt.step();
                    stmt.reset();
                }
            });
        });
        db.run("DELETE FROM entity_field_value WHERE field_id IN (SELECT id FROM custom_fields WHERE type = 'multi_list');");
    }
    stmt.free();
}

function getCustomFieldValues() {
    const vals = {};
    document.querySelectorAll('.field-input-text').forEach(inp => {
        vals[parseInt(inp.dataset.fieldId)] = inp.value;
    });
    document.querySelectorAll('.field-input-radio:checked').forEach(inp => {
        if (inp.dataset.optId) {
            const cid = parseInt(inp.dataset.fieldId);
            if (!vals[cid]) vals[cid] = [];
            vals[cid].push(inp.dataset.optId);
        }
    });
    document.querySelectorAll('.field-input-chk').forEach(chk => {
        const cid = parseInt(chk.dataset.fieldId);
        if (!vals[cid]) vals[cid] = [];
        if (chk.checked) vals[cid].push(chk.dataset.optId);
    });
    return vals;
}

function saveFieldValues(entityId, values) {
    for (const [fieldId, value] of Object.entries(values)) {
        if (Array.isArray(value)) {
            const fid = parseInt(fieldId);
            db.run("DELETE FROM entity_field_value_multi WHERE entity_id = ? AND field_id = ?;", [entityId, fid]);
            value.forEach(optId => {
                const id = parseInt(optId);
                if (!isNaN(id)) {
                    db.run("INSERT INTO entity_field_value_multi (entity_id, field_id, option_id) VALUES (?, ?, ?);",
                        [entityId, fid, id]);
                }
            });
        } else if (value === '') {
            db.run("DELETE FROM entity_field_value WHERE entity_id = ? AND field_id = ?;",
                [entityId, parseInt(fieldId)]);
        } else {
            db.run("INSERT OR REPLACE INTO entity_field_value (entity_id, field_id, value) VALUES (?, ?, ?);",
                [entityId, parseInt(fieldId), value]);
        }
    }
}

// Custom Fields Modal Buttons
document.getElementById('manageFieldsBtn').addEventListener('click', () => {
    loadCustomFields();
    document.getElementById('fieldsModal').style.display = 'flex';
    document.getElementById('fieldOptionsContainer').style.display = 'none';
    editingFieldOptionsId = null;
});
document.getElementById('closeFieldsBtn').addEventListener('click', () => {
    document.getElementById('fieldsModal').style.display = 'none';
    loadCustomFields();
    updateTable();
});

document.getElementById('addFieldBtn').addEventListener('click', () => {
    const name = document.getElementById('newFieldFieldName').value.trim();
    const description = document.getElementById('newFieldDesc').value.trim();
    const type = document.getElementById('newFieldType').value;
    if (!name) { alert('Name is required.'); return; }
    try {
        db.run("INSERT INTO custom_fields (name, description, type) VALUES (?, ?, ?);", [name, description || null, type]);
        document.getElementById('newFieldFieldName').value = '';
        document.getElementById('newFieldDesc').value = '';
        loadCustomFields();
        showNotification('Custom field "' + name + '" created', 'success');
    } catch (e) {
        alert('Error: ' + e.message);
    }
});

// Drag & Drop images to create entities
const dropZone = document.getElementById('dropZoneCard');

dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drop-hover');
});

dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('drop-hover');
});

dropZone.addEventListener('drop', async (e) => {
    e.preventDefault();
    dropZone.classList.remove('drop-hover');

    const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
    if (files.length === 0) {
        document.getElementById('dropStatus').textContent = 'Only images are accepted.';
        document.getElementById('dropStatus').style.color = '#e74c3c';
        return;
    }

    if (!imagesDirHandle) {
        document.getElementById('dropStatus').textContent = '❌ Please select an images folder in section 2 first.';
        document.getElementById('dropStatus').style.color = '#e74c3c';
        return;
    }

    document.getElementById('dropStatus').textContent = `Processing ${files.length} image(s)...`;
    document.getElementById('dropStatus').style.color = '#2ecc71';

    let created = 0;
    let errors = 0;

    for (const file of files) {
        try {
            const name = file.name.replace(/\.[^/.]+$/, '').trim();
            if (!name) { errors++; continue; }

            const existingSet = getExistingNormalizedNames();
            const duplicates = findDuplicateNames(name, existingSet);
            if (duplicates.length > 0) {
                const msg = duplicates.length === 1
                    ? `The name "${duplicates[0]}" already exists. Do you want to add it anyway?`
                    : `The following names already exist: ${duplicates.map(d => `"${d}"`).join(', ')}. Do you want to add them anyway?`;
                if (!confirm(msg)) { errors++; continue; }
            }

            db.run("INSERT INTO entities (name) VALUES (?);", [name]);
            const newId = db.exec("SELECT last_insert_rowid();");
            const entityId = newId[0].values[0][0];

            // Save features with default values
            const vals = getFeatureValues();
            saveEntityFeatures(entityId, vals);

            // Save selected tags
            const tagIds = getSelectedTagIds();
            saveEntityTags(entityId, tagIds);

            // Save custom fields
            const fieldVals = getCustomFieldValues();
            saveFieldValues(entityId, fieldVals);

            // Upload image
            const ext = file.name.split('.').pop() || 'png';
            const randomId = Math.random().toString(36).substring(2, 10);
            const filename = `${name}_${randomId}.${ext}`;
            const blob = new Blob([await file.arrayBuffer()], { type: file.type });
            await saveImageFS(blob, filename);
            db.run("UPDATE entities SET image = ?, modified_at = CURRENT_TIMESTAMP WHERE id = ?;", [filename, entityId]);

            created++;
        } catch (err) {
            errors++;
            console.error('Error processing file', file.name, err);
        }
    }

    updateTable();
    const msg = `✅ ${created} entity(ies) created` + (errors > 0 ? `, ${errors} error(s)` : '');
    if (created === 1) {
        // Find the name from the last created file
        const lastFile = files.find(f => f.name.replace(/\.[^/.]+$/, '').trim());
        if (lastFile) showNotification('Entity "' + lastFile.name.replace(/\.[^/.]+$/, '').trim() + '" created', 'success');
    } else if (created > 1) {
        showNotification(created + ' entities created', 'success');
    }
    document.getElementById('dropStatus').textContent = msg;
    document.getElementById('dropStatus').style.color = errors > 0 ? '#e67e22' : '#2ecc71';
    setTimeout(() => {
        document.getElementById('dropStatus').textContent = 'Drop images here';
        document.getElementById('dropStatus').style.color = '#999';
    }, 4000);
});

const GRADE_COLORS = {
    S: '#e74c3c', A: '#e67e22', B: '#d4a017', C: '#2ecc71',
    D: '#00bcd4', E: '#9b59b6', F: '#e91e90'
};

// ─── Filters Rendering and Processing ─────────────────────
function renderFilters() {
    const container = document.getElementById('filterContainer');
    let html = '';

    html += '<div style="display:flex;align-items:center;gap:8px;flex:1 1 100%;margin-bottom:4px">' +
        '<label class="compact-toggle" id="manualFilterToggleLabel">' +
        '<input type="checkbox" id="manualFilterToggle"' + (manualFilterMode ? ' checked' : '') + '>' +
        '<span class="toggle-slider"></span></label>' +
        '<span style="font-size:0.9em;color:#a6adc8">Manual Filter</span>' +
        '<div id="applyFilterContainer" style="display:' + (manualFilterMode ? 'inline-block' : 'none') + ';margin-left:8px">' +
        '<button id="applyFiltersBtn" style="background:#2ecc71;color:#fff;border:none;padding:4px 12px;border-radius:4px;cursor:pointer;font-size:0.85em">▶ Apply</button></div></div>';

    // Name filter
    const fn = document.getElementById('filterName') ? document.getElementById('filterName').value : '';
    html += `<div class="filter-group"><h4>Name</h4>
        <div style="display:flex;align-items:center;gap:4px">
            <input type="text" id="filterName" placeholder="Search name..." value="${fn}" style="flex:1">
            <button class="clear-filter-btn" data-target="filterName" style="padding:2px 6px;font-size:0.8em;background:#585b70;color:#e0e0e0;margin:0">✖</button>
        </div></div>`;

    // Features filters
    if (featuresList.length > 0) {
        html += '<div class="filter-group"><h4>Features</h4>';
        featuresList.forEach(c => {
            const selId = `filter_feature_${c.id}`;
            const cur = document.getElementById(selId) ? document.getElementById(selId).value : '';
            html += `<label>${c.name}:
                <select id="${selId}" style="margin:2px 0">
                    <option value="">—</option>
                    <option value="S" ${cur === 'S' ? 'selected' : ''}>S</option>
                    <option value="A" ${cur === 'A' ? 'selected' : ''}>A</option>
                    <option value="B" ${cur === 'B' ? 'selected' : ''}>B</option>
                    <option value="C" ${cur === 'C' ? 'selected' : ''}>C</option>
                    <option value="D" ${cur === 'D' ? 'selected' : ''}>D</option>
                    <option value="E" ${cur === 'E' ? 'selected' : ''}>E</option>
                    <option value="F" ${cur === 'F' ? 'selected' : ''}>F</option>
                </select>
            </label><br>`;
        });
        html += '</div>';
    }

    // Tags filters
    if (tagsList.length > 0) {
        html += '<div class="filter-group"><h4>Tags</h4>';
        html += '<div style="display:flex;align-items:center;gap:4px">' +
            '<input type="text" class="filter-input" placeholder="Filter tags..." oninput="filterOptions(this)" style="flex:1">' +
            '<button class="clear-filter-btn" style="padding:2px 6px;font-size:0.8em;background:#585b70;color:#e0e0e0;margin:0">✖</button></div>';
        html += '<div class="filterable-list compact">';
        [...tagsList].sort((a, b) => a.name.localeCompare(b.name)).forEach(e => {
            const chkId = `filter_tag_${e.id}`;
            const checked = document.getElementById(chkId) ? document.getElementById(chkId).checked : false;
            html += `<label data-name="${(e.name + ' ' + (e.description || '')).toLowerCase()}"><input type="checkbox" id="${chkId}" ${checked ? 'checked' : ''}> ${e.description || e.name}</label><br>`;
        });
        html += '</div></div>';
    }

    // Custom fields filters
    if (customFieldsList.length > 0) {
        const sortedCf = [...customFieldsList].sort((a, b) => a.name.localeCompare(b.name));
        html += '<div class="filter-group" style="flex:1 1 100%"><h4>Custom Fields</h4>';
        html += '<div style="display:flex;flex-wrap:wrap;gap:8px">';
        sortedCf.forEach(c => {
            html += `<div class="filter-group" style="flex:1;min-width:160px">`;
            html += `<h4>${c.name}</h4>`;
            const inpId = `filter_field_${c.id}`;
            if (c.type === 'text') {
                const cur = document.getElementById(inpId) ? document.getElementById(inpId).value : '';
                html += `<div style="display:flex;align-items:center;gap:4px">
                    <input type="text" id="${inpId}" placeholder="Filter..." value="${cur}" style="flex:1">
                    <button class="clear-filter-btn" data-target="${inpId}" style="padding:2px 6px;font-size:0.8em;background:#585b70;color:#e0e0e0;margin:0">✖</button>
                </div>`;
            } else {
                const opts = getFieldOptions(c.id);
                const isMulti = c.type === 'multi_list';
                        html += '<div style="display:flex;align-items:center;gap:4px">' +
                            '<input type="text" class="filter-input" placeholder="Filter options..." oninput="filterFieldOptions(this)" style="flex:1">' +
                            '<button class="clear-filter-btn" style="padding:2px 6px;font-size:0.8em;background:#585b70;color:#e0e0e0;margin:0">✖</button></div>';
                html += '<div class="filterable-list compact">';
                const cur = document.getElementById(inpId) ? document.getElementById(inpId).value : '';
                const curIds = cur ? cur.split(',').map(Number) : [];
                opts.forEach(o => {
                    if (isMulti) {
                        const checked = curIds.includes(o.id) ? 'checked' : '';
                        html += `<label data-optname="${o.value.toLowerCase()}" style="font-size:0.85em;white-space:nowrap;display:block">
                            <input type="checkbox" class="filter-field-chk" data-field-id="${c.id}" data-opt-id="${o.id}" ${checked}> ${o.value}
                        </label>`;
                    } else {
                        const checked = curIds.includes(o.id) ? 'checked' : '';
                        html += `<label data-optname="${o.value.toLowerCase()}" style="font-size:0.85em;white-space:nowrap;display:block">
                            <input type="radio" name="filter_radio_${c.id}" class="filter-field-radio" data-field-id="${c.id}" data-opt-id="${o.id}" ${checked ? 'checked' : ''}> ${o.value}
                        </label>`;
                    }
                });
                html += '</div>';
            }
            html += '</div>';
        });
        html += '</div></div>';
    }

    html += '<div style="flex:1 1 100%;margin-top:8px"><button id="clearAllFiltersBtn" style="background:#e74c3c;color:#fff;border:none;padding:6px 14px;border-radius:4px;cursor:pointer">✖ Clear all filters</button></div>';

    container.innerHTML = html;

    // Manual filter toggle
    document.getElementById('manualFilterToggle').addEventListener('change', function() {
        manualFilterMode = this.checked;
        renderFilters();
        if (!manualFilterMode) updateTable();
    });

    document.getElementById('clearAllFiltersBtn').addEventListener('click', () => {
        container.querySelectorAll('input, select').forEach(el => {
            if (el.type === 'checkbox' || el.type === 'radio') {
                el.checked = false;
            } else {
                el.value = '';
            }
        });
        currentPage = 1;
        updateTable();
    });

    // Assign change/input listeners to refresh table values
    container.querySelectorAll('input, select').forEach(el => {
        el.addEventListener('change', () => { currentPage = 1; if (!manualFilterMode) updateTable(); });
        if (el.tagName === 'INPUT' && el.type === 'text') {
            el.addEventListener('input', () => { currentPage = 1; if (!manualFilterMode) updateTable(); });
        }
    });

    // Apply Filters button (manual mode)
    const applyBtn = document.getElementById('applyFiltersBtn');
    if (applyBtn) {
        applyBtn.addEventListener('click', () => {
            currentPage = 1;
            updateTable();
        });
    }

    // Clear filter text inputs
    container.querySelectorAll('.clear-filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const input = document.getElementById(btn.dataset.target);
            if (input) {
                input.value = '';
                currentPage = 1;
                if (!manualFilterMode) updateTable();
            }
        });
    });
}

function getActiveFilters() {
    const f = { name: '', feature: {}, tag: [], field: {} };

    const fn = document.getElementById('filterName');
    if (fn) f.name = fn.value.toLowerCase().trim();

    featuresList.forEach(c => {
        const el = document.getElementById(`filter_feature_${c.id}`);
        if (el && el.value) f.feature[c.id] = el.value;
    });

    tagsList.forEach(e => {
        const el = document.getElementById(`filter_tag_${e.id}`);
        if (el && el.checked) f.tag.push(e.id);
    });

    customFieldsList.forEach(c => {
        if (c.type === 'multi_list') {
            const chks = document.querySelectorAll(`.filter-field-chk[data-field-id="${c.id}"]:checked`);
            const vals = Array.from(chks).map(el => parseInt(el.dataset.optId)).filter(v => !isNaN(v));
            if (vals.length > 0) f.field[c.id] = vals.join(',');
        } else if (c.type === 'single_list') {
            const radio = document.querySelector(`.filter-field-radio[data-field-id="${c.id}"]:checked`);
            if (radio) f.field[c.id] = String(radio.dataset.optId);
        } else {
            const el = document.getElementById(`filter_field_${c.id}`);
            if (el && el.value) f.field[c.id] = el.value;
        }
    });

    return f;
}

function filterEntities(rows, filters) {
    const featureMap = {};
    const featureRes = db.exec(`SELECT entity_id, feature_id, value FROM entity_features;`);
    if (featureRes.length > 0) {
        featureRes[0].values.forEach(r => {
            if (!featureMap[r[0]]) featureMap[r[0]] = {};
            featureMap[r[0]][r[1]] = r[2];
        });
    }

    const tagMap = {};
    const tagRes = db.exec(`SELECT entity_id, tag_id FROM entity_tags;`);
    if (tagRes.length > 0) {
        tagRes[0].values.forEach(r => {
            if (!tagMap[r[0]]) tagMap[r[0]] = [];
            tagMap[r[0]].push(r[1]);
        });
    }

    const fieldMap = {};
    const fieldRes = db.exec("SELECT entity_id, field_id, value FROM entity_field_value;");
    if (fieldRes.length > 0) {
        fieldRes[0].values.forEach(r => {
            if (!fieldMap[r[0]]) fieldMap[r[0]] = {};
            fieldMap[r[0]][r[1]] = r[2];
        });
    }
    const multiRes = db.exec("SELECT entity_id, field_id, option_id FROM entity_field_value_multi;");
    if (multiRes.length > 0) {
        multiRes[0].values.forEach(r => {
            const eid = r[0], fid = r[1], oid = r[2];
            if (!fieldMap[eid]) fieldMap[eid] = {};
            if (!fieldMap[eid][fid]) fieldMap[eid][fid] = [];
            fieldMap[eid][fid].push(String(oid));
        });
    }

    return rows.filter(row => {
        const uid = row[0];

        // Name
        if (filters.name && !String(row[1]).toLowerCase().includes(filters.name)) return false;

        // Features
        for (const [featureId, expectedVal] of Object.entries(filters.feature)) {
            const entityVal = featureMap[uid] ? featureMap[uid][featureId] : null;
            if (entityVal !== expectedVal) return false;
        }

        // Tags
        for (const tagId of filters.tag) {
            const hasTag = tagMap[uid] && tagMap[uid].includes(tagId);
            if (!hasTag) return false;
        }

        // Custom fields
        for (const [fieldId, expectedVal] of Object.entries(filters.field)) {
            const entityVal = fieldMap[uid] ? fieldMap[uid][fieldId] : null;
            if (entityVal === undefined) return false;
            const field = customFieldsList.find(c => c.id === parseInt(fieldId));
            if (field && field.type === 'text') {
                if (!String(entityVal).toLowerCase().includes(String(expectedVal).toLowerCase())) return false;
            } else if (field && field.type === 'multi_list') {
                const expectedIds = String(expectedVal).split(',').filter(Boolean);
                const entityIds = String(entityVal).split(',').filter(Boolean);
                const hasAny = expectedIds.some(id => entityIds.includes(id));
                if (!hasAny) return false;
            } else {
                const ids = String(entityVal).split(',').filter(Boolean);
                if (!ids.includes(String(expectedVal))) return false;
            }
        }

        return true;
    });
}

// Render main data components into HTML layout table
function updateTable() {
    if (!db) return;

    try {
        const res = db.exec("SELECT * FROM entities;");
        const container = document.getElementById('tableContainer');

        if (res.length === 0 || res[0].values.length === 0) {
            container.innerHTML = "<em>The 'entities' table is empty.</em>";
            return;
        }

        const columns = res[0].columns;
        let rows = res[0].values;

        // Fetch entity features
        const featureRes = db.exec(`SELECT ue.entity_id, c.name, ue.value, c.factor
            FROM entity_features ue JOIN features c ON ue.feature_id = c.id;`);
        const userFeatures = {};
        if (featureRes.length > 0) {
            featureRes[0].values.forEach(r => {
                const uid = r[0];
                if (!userFeatures[uid]) userFeatures[uid] = [];
                userFeatures[uid].push({ name: r[1], value: r[2], factor: r[3] });
            });
        }

        // Fetch entity tags
        const tagRes = db.exec(`SELECT ut.entity_id, e.name, e.factor, e.description
            FROM entity_tags ut JOIN tags e ON ut.tag_id = e.id;`);
        const userTags = {};
        if (tagRes.length > 0) {
            tagRes[0].values.forEach(r => {
                const uid = r[0];
                if (!userTags[uid]) userTags[uid] = [];
                userTags[uid].push({ name: r[1], factor: r[2], description: r[3] });
            });
        }

        // Fetch entity custom fields values
        const fieldValRes = db.exec("SELECT entity_id, field_id, value FROM entity_field_value;");
        const userFieldVals = {};
        if (fieldValRes.length > 0) {
            fieldValRes[0].values.forEach(r => {
                const uid = r[0];
                if (!userFieldVals[uid]) userFieldVals[uid] = {};
                userFieldVals[uid][r[1]] = r[2];
            });
        }
        const multiValRes = db.exec("SELECT entity_id, field_id, option_id FROM entity_field_value_multi;");
        if (multiValRes.length > 0) {
            multiValRes[0].values.forEach(r => {
                const uid = r[0], fid = r[1], oid = r[2];
                if (!userFieldVals[uid]) userFieldVals[uid] = {};
                if (!userFieldVals[uid][fid]) userFieldVals[uid][fid] = [];
                userFieldVals[uid][fid].push(String(oid));
            });
        }

        // Apply filters
        const filters = getActiveFilters();
        rows = filterEntities(rows, filters);

        // Score Calculation setup
        const allFieldOpts = {};
        customFieldsList.forEach(c => {
            if (c.type === 'single_list' || c.type === 'multi_list') {
                allFieldOpts[c.id] = getFieldOptions(c.id);
            }
        });

        const GRADE_VALS = { S: 5, A: 4, B: 3, C: 2, D: 1, E: -1, F: -2 };

        function calculateScore(uid) {
            let score = 0;
            (userFeatures[uid] || []).forEach(c => {
                const factor = c.factor != null ? c.factor : 1;
                const gv = GRADE_VALS[c.value] || 0;
                score += factor * gv;
            });

            (customFieldsList || []).forEach(c => {
                if (c.type !== 'single_list' && c.type !== 'multi_list') return;
                const cv = userFieldVals[uid] || {};
                const val = cv[c.id];
                if (val === undefined) return;
                const selectedIds = String(val).split(',').filter(Boolean);
                const opts = allFieldOpts[c.id] || [];
                const sel = opts.filter(o => selectedIds.includes(String(o.id)));
                if (sel.length > 0) {
                    const sum = sel.reduce((a, o) => a + (o.factor != null ? o.factor : 1), 0);
                    score *= sum / sel.length;
                }
            });

            (userTags[uid] || []).forEach(e => {
                score *= (e.factor != null ? e.factor : 1);
            });

            return Math.round(score * 100) / 100;
        }

        if (sortColumn === -1) {
            rows.sort((a, b) => {
                const pa = calculateScore(a[0]);
                const pb = calculateScore(b[0]);
                return sortAsc ? pa - pb : pb - pa;
            });
        } else if (sortColumn !== null) {
            rows.sort((a, b) => {
                const valA = a[sortColumn];
                const valB = b[sortColumn];
                if (valA < valB) return sortAsc ? -1 : 1;
                if (valA > valB) return sortAsc ? 1 : -1;
                return 0;
            });
        }

        const colNameIndex = columns.indexOf('name');
        const colImageIndex = columns.indexOf('image');
        const colImage2Index = columns.indexOf('image_2');
        const colImage3Index = columns.indexOf('image_3');

        // Build image navigation list from filtered+sorted rows
        imageNavList = rows
            .filter(r => r[colImageIndex] || r[colImage2Index] || r[colImage3Index])
            .map(r => ({
                id: r[0],
                name: r[1],
                files: [r[colImageIndex], r[colImage2Index], r[colImage3Index]].filter(Boolean)
            }));
        imageNavIndex = -1;

        // Pagination
        const totalFilteredRows = rows.length;
        const totalPages = Math.ceil(totalFilteredRows / pageSize) || 1;
        if (currentPage > totalPages) currentPage = totalPages;
        const startIdx = (currentPage - 1) * pageSize;

        if (totalFilteredRows === 0) {
            container.innerHTML = '<em style="color:#6c7086">No entities match the selected filters.</em>';
            return;
        }

        rows = rows.slice(startIdx, startIdx + pageSize);

        let html = '<table><thead><tr>';
        columns.forEach((col, i) => {
            if (compactMode && col !== 'name' && col !== 'image') return;
            if (col === 'image') {
                html += '<th>Image</th>';
                return;
            }
            if (col === 'id' || col === 'date' || col === 'modified_at' || col === 'image_2' || col === 'image_3') return;
            const indicator = sortColumn === i ? (sortAsc ? ' ▲' : ' ▼') : '';
            html += `<th data-col="${i}" style="cursor:pointer">${col.charAt(0).toUpperCase() + col.slice(1)}${indicator}</th>`;
        });
        const indicScore = sortColumn === -1 ? (sortAsc ? ' ▲' : ' ▼') : '';
        html += `<th data-col="-1" style="cursor:pointer">Score${indicScore}</th>`;
        if (!compactMode) {
            html += '<th>Features</th><th>Tags</th><th>Custom Fields</th>';
            const colDateIndex = columns.indexOf('date');
            const dateIndicator = sortColumn === colDateIndex ? (sortAsc ? ' ▲' : ' ▼') : '';
            html += `<th data-col="${colDateIndex}" style="cursor:pointer;font-size:0.9em">Date${dateIndicator}</th>`;
            const colModAtIndex = columns.indexOf('modified_at');
            const modAtIndicator = sortColumn === colModAtIndex ? (sortAsc ? ' ▲' : ' ▼') : '';
            html += `<th data-col="${colModAtIndex}" style="cursor:pointer;font-size:0.9em">Modified at${modAtIndicator}</th>`;
            html += '<th>Actions</th>';
        }
        html += '</tr></thead><tbody>';

        rows.forEach(row => {
            const id = row[0];
            const filename = row[colImageIndex] || null;
            const features = userFeatures[id] || [];
            html += `<tr data-id="${id}" style="cursor:default">`;
            row.forEach((cell, i) => {
                const colName = columns[i];
                if (compactMode && colName !== 'name' && colName !== 'image') return;
                if (colName === 'id' || colName === 'date' || colName === 'modified_at' || colName === 'image_2' || colName === 'image_3') return;
                if (colName === 'image') {
                    if (cell) {
                        html += `<td><img class="img-thumb view-img" data-id="${id}" data-file="${cell}" data-name="${row[colNameIndex]}" src="" title="${cell}"></td>`;
                    } else {
                        html += '<td><em>No image</em></td>';
                    }
                } else if (i === colNameIndex) {
                    html += `<td class="editable" data-id="${id}" data-col="${i}">${cell}</td>`;
                } else {
                    html += `<td>${cell}</td>`;
                }
            });
            // Score Column
            const score = calculateScore(id);
            html += `<td style="font-weight:bold;text-align:center">${score}</td>`;
            if (compactMode) { html += '</tr>'; return; }
            // Features Column
            html += '<td class="feature-cell" data-id="' + id + '">';
            if (features.length > 0) {
                const gradeOrder = { S: 0, A: 1, B: 2, C: 3, D: 4, E: 5, F: 6 };
                features.sort((a, b) => (gradeOrder[a.value] ?? 99) - (gradeOrder[b.value] ?? 99));
                features.forEach(c => {
                    const color = GRADE_COLORS[c.value] || '#333';
                    html += `<span class="feature-badge" style="display:inline-block;margin:1px 4px 1px 0;padding:1px 6px;border-radius:3px;background:${color}20;color:${color};font-weight:bold;font-size:0.85em">${c.name}: ${c.value}</span>`;
                });
            } else {
                html += '<em style="font-size:0.85em;color:#6c7086">—</em>';
            }
            html += '</td>';
            // Tags Column
            html += '<td class="tag-cell" data-id="' + id + '">';
            const tags = userTags[id] || [];
            if (tags.length > 0) {
                tags.forEach(t => {
                    html += `<span class="tag-badge">${t.description || t.name}</span>`;
                });
            } else {
                html += '<em style="font-size:0.85em;color:#6c7086">—</em>';
            }
            html += '</td>';
            // Custom Fields Column
            html += '<td class="field-cell" data-id="' + id + '" style="max-width:250px;font-size:0.85em">';
            const cvals = userFieldVals[id] || {};
            let hasFieldVal = false;
            if (customFieldsList.length > 0) {
                customFieldsList.forEach(c => {
                    const v = cvals[c.id];
                    if (v) {
                        hasFieldVal = true;
                        if (c.type === 'text') {
                            html += `<div><strong>${c.name}:</strong> ${v}</div>`;
                        } else {
                            const opts = getFieldOptions(c.id);
                            const selectedIds = Array.isArray(v) ? v : String(v).split(',').filter(Boolean);
                            const labels = opts.filter(o => selectedIds.includes(String(o.id))).map(o => o.value);
                            html += `<div><strong>${c.name}:</strong> ${labels.join(', ') || '—'}</div>`;
                        }
                    }
                });
            }
            if (!hasFieldVal) {
                html += '<em style="color:#6c7086">—</em>';
            }
            html += '</td>';
            // Date Column
            const colDateIndex = columns.indexOf('date');
            const dateVal = row[colDateIndex];
            if (dateVal) {
                const parts = dateVal.split(' ');
                html += `<td style="font-size:0.75em;line-height:1.4;text-align:center;vertical-align:middle;white-space:nowrap"><div>${parts[0] || ''}</div><div>${parts[1] || ''}</div></td>`;
            } else {
                html += '<td style="font-size:0.75em;text-align:center;color:#6c7086">—</td>';
            }
            // Modified At Column
            const colModAtIndex = columns.indexOf('modified_at');
            const modAtVal = row[colModAtIndex];
            if (modAtVal) {
                const parts = modAtVal.split(' ');
                html += `<td style="font-size:0.75em;line-height:1.4;text-align:center;vertical-align:middle;white-space:nowrap"><div>${parts[0] || ''}</div><div>${parts[1] || ''}</div></td>`;
            } else {
                html += '<td style="font-size:0.75em;text-align:center;color:#6c7086">—</td>';
            }
            // Actions Column
            html += '<td style="display:flex;flex-direction:column;gap:4px">';
            html += `<button class="edit-btn" data-id="${id}">✏️ Edit</button>`;
            html += `<button class="img-btn upload-img" data-id="${id}" style="background-color:#e67e22;">🖼️ Upload</button>`;
            if (filename || row[colImage2Index] || row[colImage3Index]) {
                html += `<button class="img-btn view-img-btn" data-id="${id}" style="background-color:#2ecc71;">👁️ View</button>`;
            }
            html += `<button class="del-entity-btn" data-id="${id}" style="background-color:#e74c3c;">🗑️ Delete</button>`;
            html += '</td>';
            html += '</tr>';
        });
        html += '</tbody></table>';

        // Pagination bar
        const startRow = startIdx + 1;
        const endRow = Math.min(startIdx + pageSize, totalFilteredRows);
        html += '<div class="pagination-bar">';
        html += '<div class="pagination-info">Showing ' + startRow + '&ndash;' + endRow + ' of ' + totalFilteredRows + ' entities</div>';
        html += '<div class="pagination-controls">';
        html += '<button class="page-btn" data-page="prev"' + (currentPage <= 1 ? ' disabled' : '') + '>&#8249;</button>';
        const pgRange = 2;
        let pgStart = Math.max(1, currentPage - pgRange);
        let pgEnd = Math.min(totalPages, currentPage + pgRange);
        if (pgStart > 1) {
            html += '<button class="page-btn" data-page="1">1</button>';
            if (pgStart > 2) html += '<span class="page-ellipsis">&hellip;</span>';
        }
        for (let i = pgStart; i <= pgEnd; i++) {
            html += '<button class="page-btn' + (i === currentPage ? ' active' : '') + '" data-page="' + i + '">' + i + '</button>';
        }
        if (pgEnd < totalPages) {
            if (pgEnd < totalPages - 1) html += '<span class="page-ellipsis">&hellip;</span>';
            html += '<button class="page-btn" data-page="' + totalPages + '">' + totalPages + '</button>';
        }
        html += '<button class="page-btn" data-page="next"' + (currentPage >= totalPages ? ' disabled' : '') + '>&#8250;</button>';
        html += '</div>';
        html += '<div class="pagination-size"><label>Rows per page: <select class="page-size-select">';
        [50, 100, 200, 1000].forEach(function(s) {
            html += '<option value="' + s + '"' + (s === pageSize ? ' selected' : '') + '>' + s + '</option>';
        });
        html += '</select></label></div></div>';

        container.innerHTML = html;

        // Headers sorting listeners
        container.querySelectorAll('th[data-col]').forEach(th => {
            th.addEventListener('click', () => {
                const col = parseInt(th.dataset.col);
                if (sortColumn === col) {
                    sortAsc = !sortAsc;
                } else {
                    sortColumn = col;
                    sortAsc = true;
                }
                updateTable();
            });
        });

        // Row action items triggers (Edit/Save toggles)
        container.querySelectorAll('.edit-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const id = btn.dataset.id;
                const td = container.querySelector(`td.editable[data-id="${id}"]`);
                const featureCell = container.querySelector(`td.feature-cell[data-id="${id}"]`);
                const tagCell = container.querySelector(`td.tag-cell[data-id="${id}"]`);
                const fieldCell = container.querySelector(`td.field-cell[data-id="${id}"]`);
                const currentVal = td.textContent;

                if (btn.textContent.includes('Edit')) {
                    td.innerHTML = `<input type="text" value="${currentVal}" class="edit-input">`;
                    btn.textContent = '💾 Save';
                    btn.style.marginBottom = '2px';
                    const cancelBtn = document.createElement('button');
                    cancelBtn.textContent = '✖ Cancel';
                    cancelBtn.className = 'cancel-edit-btn';
                    cancelBtn.style.cssText = 'padding:4px 8px;font-size:0.85em;background-color:#95a5a6;color:white;border:none;border-radius:3px;cursor:pointer';
                    cancelBtn.addEventListener('click', () => updateTable());
                    btn.parentNode.insertBefore(cancelBtn, btn.nextSibling);

                    // Feature items selectors matching layout
                    if (featureCell && featuresList.length > 0) {
                        const featureRes = db.exec(
                            "SELECT feature_id, value FROM entity_features WHERE entity_id = ?;",
                            [parseInt(id)]);
                        const vals = {};
                        if (featureRes.length > 0) {
                            featureRes[0].values.forEach(r => { vals[r[0]] = r[1]; });
                        }
                        const grades = ['F', 'E', 'D', 'C', 'B', 'A', 'S'];
                        let selHtml = '<div style="display:flex;flex-wrap:wrap;gap:4px">';
                        featuresList.forEach(c => {
                            const v = vals[c.id] || 'D';
                            selHtml += `<label style="font-size:0.85em">${c.name}:
                                <select class="feature-edit-select" data-feature-id="${c.id}" style="padding:1px 2px;font-size:0.85em">
                                    ${grades.map(g => `<option value="${g}" ${g === v ? 'selected' : ''}>${g}</option>`).join('')}
                                </select>
                            </label>`;
                        });
                        selHtml += '</div>';
                        featureCell.innerHTML = selHtml;
                    }

                    // Tags lists to checkboxes configuration
                    if (tagCell && tagsList.length > 0) {
                        const tagRes = db.exec(
                            "SELECT tag_id FROM entity_tags WHERE entity_id = ?;",
                            [parseInt(id)]);
                        const selIds = new Set();
                        if (tagRes.length > 0) {
                            tagRes[0].values.forEach(r => selIds.add(r[0]));
                        }
                                let chkHtml = '<div style="display:flex;align-items:center;gap:4px">' +
                                    '<input type="text" class="filter-input" placeholder="Filter tags..." oninput="filterOptions(this)" style="flex:1">' +
                                    '<button class="clear-filter-btn" style="padding:2px 6px;font-size:0.8em;background:#585b70;color:#e0e0e0;margin:0">✖</button></div>';
                                chkHtml += '<div class="filterable-list compact">';
                        [...tagsList].sort((a, b) => a.name.localeCompare(b.name)).forEach(e => {
                            const checked = selIds.has(e.id) ? 'checked' : '';
                            chkHtml += `<label data-name="${(e.name + ' ' + (e.description || '')).toLowerCase()}" class="tag-edit-label" style="font-size:0.85em;white-space:nowrap">
                                <input type="checkbox" class="tag-edit-check" data-tag-id="${e.id}" ${checked}>
                                ${e.description || e.name}
                            </label>`;
                        });
                        chkHtml += '</div>';
                        tagCell.innerHTML = chkHtml;
                    }

                    // Custom Field properties selectors
                    if (fieldCell && customFieldsList.length > 0) {
                        const cv = db.exec("SELECT field_id, value FROM entity_field_value WHERE entity_id = ?;", [parseInt(id)]);
                        const saved = {};
                        if (cv.length > 0) {
                            cv[0].values.forEach(r => { saved[r[0]] = r[1]; });
                        }
                        const multiCv = db.exec("SELECT field_id, option_id FROM entity_field_value_multi WHERE entity_id = ?;", [parseInt(id)]);
                        if (multiCv.length > 0) {
                            multiCv[0].values.forEach(r => {
                                const fid = r[0];
                                if (!saved[fid]) saved[fid] = [];
                                saved[fid].push(String(r[1]));
                            });
                        }
                                let fieldEditHtml = '<div style="display:flex;align-items:center;gap:4px">' +
                                    '<input type="text" class="filter-input" placeholder="Filter option values..." oninput="filterFieldOptions(this)" style="flex:1">' +
                                    '<button class="clear-filter-btn" style="padding:2px 6px;font-size:0.8em;background:#585b70;color:#e0e0e0;margin:0">✖</button></div>';
                                fieldEditHtml += '<div class="filterable-list" style="max-height:250px">';
                        customFieldsList.forEach(c => {
                            if (c.type === 'text') {
                                const val = saved[c.id] || '';
                                fieldEditHtml += `<label style="display:flex;flex-direction:column;gap:1px;font-size:0.85em">
                                    ${c.name} <input type="text" class="field-edit-text" data-field-id="${c.id}" value="${val}" style="padding:1px 4px">
                                </label>`;
                            } else {
                                const opts = getFieldOptions(c.id);
                                const isMulti = c.type === 'multi_list';
                                const savedIds = saved[c.id] ? (Array.isArray(saved[c.id]) ? saved[c.id] : String(saved[c.id]).split(',').filter(Boolean)) : [];
                                fieldEditHtml += `<fieldset style="border:1px solid #45475a;border-radius:3px;padding:2px 4px;margin:2px">
                                    <legend style="font-size:0.8em">${c.name}</legend>`;
                                opts.forEach(o => {
                                    const oid = String(o.id);
                                    if (isMulti) {
                                        const checked = savedIds.includes(oid) ? 'checked' : '';
                                        fieldEditHtml += `<label data-optname="${o.value.toLowerCase()}" style="font-size:0.85em;white-space:nowrap">
                                            <input type="checkbox" class="field-edit-chk" data-field-id="${c.id}" data-opt-id="${o.id}" ${checked}> ${o.value}
                                        </label>`;
                                    } else {
                                        const checked = savedIds.includes(oid) ? 'checked' : '';
                                        fieldEditHtml += `<label data-optname="${o.value.toLowerCase()}" style="font-size:0.85em;white-space:nowrap">
                                            <input type="radio" class="field-edit-radio" name="field_edit_radio_${c.id}_${id}" data-field-id="${c.id}" data-opt-id="${o.id}" ${checked}> ${o.value}
                                        </label>`;
                                    }
                                });
                                fieldEditHtml += '</fieldset>';
                            }
                        });
                        fieldEditHtml += '</div></div>';
                        fieldCell.innerHTML = fieldEditHtml;
                    }

                    // Image cell - show thumbnails with delete buttons
                    const tr = btn.closest('tr');
                    const imgCell = tr.querySelector('td img.view-img')?.closest('td');
                    if (imgCell) {
                        const imgRes = db.exec("SELECT image, image_2, image_3 FROM entities WHERE id = ?;", [parseInt(id)]);
                        const images = imgRes.length > 0 ? imgRes[0].values[0] : [null, null, null];
                        const cols = ['image', 'image_2', 'image_3'];
                        let imgHtml = '<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">';
                        cols.forEach((col, i) => {
                            const file = images[i];
                            imgHtml += '<div style="display:flex;flex-direction:column;align-items:center;gap:2px;position:relative">';
                            if (file) {
                                imgHtml += `<img class="img-thumb edit-img-thumb" data-file="${file}" src="" style="width:50px;height:50px">`;
                                imgHtml += `<button class="del-edit-img-btn" data-col="${col}" data-file="${file}" style="padding:1px 5px;font-size:0.7em;background-color:#e74c3c;color:white;border:none;border-radius:3px;cursor:pointer;line-height:1.4">✖</button>`;
                            } else {
                                imgHtml += '<div style="width:50px;height:50px;border:1px dashed #585b70;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:0.65em;color:#6c7086">empty</div>';
                            }
                            imgHtml += '</div>';
                        });
                        imgHtml += '</div>';
                        imgCell.innerHTML = imgHtml;
                        imgCell.querySelectorAll('.edit-img-thumb').forEach(img => {
                            (async () => {
                                try { img.src = await getImageURL(img.dataset.file); } catch (_) {}
                            })();
                        });
                        imgCell.querySelectorAll('.del-edit-img-btn').forEach(delBtn => {
                            delBtn.addEventListener('click', async () => {
                                if (!confirm('Delete this image?')) return;
                                const col = delBtn.dataset.col;
                                const file = delBtn.dataset.file;
                                try {
                                    await deleteImageFS(file);
                                    db.run(`UPDATE entities SET ${col} = NULL, modified_at = CURRENT_TIMESTAMP WHERE id = ?;`, [parseInt(id)]);
                                    updateTable();
                                    showNotification('Image deleted', 'error');
                                } catch (err) {
                                    alert('Error deleting image: ' + err.message);
                                }
                            });
                        });
                    }
                } else {
                    const input = td.querySelector('.edit-input');
                    const newName = input.value.trim();
                    if (!newName) {
                        alert("Name field cannot be left blank.");
                        return;
                    }
                    db.run("UPDATE entities SET name = ?, modified_at = CURRENT_TIMESTAMP WHERE id = ?;", [newName, id]);

                    // Store features data structures modifications
                    const selects = featureCell ? featureCell.querySelectorAll('.feature-edit-select') : [];
                    selects.forEach(sel => {
                        const featureId = parseInt(sel.dataset.featureId);
                        const value = sel.value;
                        db.run("INSERT OR REPLACE INTO entity_features (entity_id, feature_id, value) VALUES (?, ?, ?);",
                            [parseInt(id), featureId, value]);
                    });

                    // Store modified tag relations structures mapping
                    const tagChecks = tagCell ? tagCell.querySelectorAll('.tag-edit-check:checked') : [];
                    const selectedIds = Array.from(tagChecks).map(c => parseInt(c.dataset.tagId));
                    db.run("DELETE FROM entity_tags WHERE entity_id = ?;", [parseInt(id)]);
                    selectedIds.forEach(eid => {
                        db.run("INSERT INTO entity_tags (entity_id, tag_id) VALUES (?, ?);", [parseInt(id), eid]);
                    });

                    // Store edited custom fields inputs content definitions
                    if (fieldCell) {
                        const fieldVals = {};
                        fieldCell.querySelectorAll('.field-edit-text').forEach(inp => {
                            fieldVals[parseInt(inp.dataset.fieldId)] = inp.value;
                        });
                        fieldCell.querySelectorAll('.field-edit-radio:checked').forEach(inp => {
                            if (inp.dataset.optId) {
                                const cid = parseInt(inp.dataset.fieldId);
                                if (!fieldVals[cid]) fieldVals[cid] = [];
                                fieldVals[cid].push(inp.dataset.optId);
                            }
                        });
                        fieldCell.querySelectorAll('.field-edit-chk').forEach(chk => {
                            const cid = parseInt(chk.dataset.fieldId);
                            if (!fieldVals[cid]) fieldVals[cid] = [];
                            if (chk.checked) fieldVals[cid].push(chk.dataset.optId);
                        });
                        const eid = parseInt(id);
                        for (const [k, v] of Object.entries(fieldVals)) {
                            const fid = parseInt(k);
                            if (Array.isArray(v)) {
                                db.run("DELETE FROM entity_field_value_multi WHERE entity_id = ? AND field_id = ?;", [eid, fid]);
                                v.forEach(optId => {
                                    const oid = parseInt(optId);
                                    if (!isNaN(oid)) {
                                        db.run("INSERT INTO entity_field_value_multi (entity_id, field_id, option_id) VALUES (?, ?, ?);",
                                            [eid, fid, oid]);
                                    }
                                });
                            } else if (v === '') {
                                db.run("DELETE FROM entity_field_value WHERE entity_id = ? AND field_id = ?;", [eid, fid]);
                            } else {
                                db.run("INSERT OR REPLACE INTO entity_field_value (entity_id, field_id, value) VALUES (?, ?, ?);",
                                    [eid, fid, v]);
                            }
                        }
                    }

                    updateTable();
                    showNotification('Entity "' + newName + '" updated', 'warning');
                }
            });
        });

        // Assign events to image upload buttons
        container.querySelectorAll('.upload-img').forEach(btn => {
            btn.addEventListener('click', () => {
                uploadImageId = parseInt(btn.dataset.id);
                document.getElementById('imageInput').click();
            });
        });

        // Assign events to image viewer buttons
        container.querySelectorAll('.view-img-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const entityId = parseInt(btn.dataset.id);
                const idx = imageNavList.findIndex(item => item.id === entityId);
                if (idx !== -1) {
                    showImageModalByIndex(idx);
                }
            });
        });

        // Delete entity
        container.querySelectorAll('.del-entity-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                if (!confirm('Delete this entity?')) return;
                const id = parseInt(btn.dataset.id);
                const nameTd = container.querySelector('td.editable[data-id="' + id + '"]');
                const entityName = nameTd ? nameTd.textContent : 'Unknown';
                db.run("DELETE FROM entity_features WHERE entity_id = ?;", [id]);
                db.run("DELETE FROM entity_tags WHERE entity_id = ?;", [id]);
                db.run("DELETE FROM entity_field_value WHERE entity_id = ?;", [id]);
                db.run("DELETE FROM entity_field_value_multi WHERE entity_id = ?;", [id]);
                db.run("DELETE FROM entities WHERE id = ?;", [id]);
                updateTable();
                showNotification('Entity "' + entityName + '" deleted', 'error');
            });
        });

        // Drag & drop file implementation on individual row indices
        container.querySelectorAll('tr[data-id]').forEach(tr => {
            tr.addEventListener('dragover', (e) => {
                e.preventDefault();
                tr.style.outline = '2px dashed #3498db';
            });
            tr.addEventListener('dragleave', () => {
                tr.style.outline = '';
            });
            tr.addEventListener('drop', async (e) => {
                e.preventDefault();
                tr.style.outline = '';
                const file = e.dataTransfer.files[0];
                if (!file || !file.type.startsWith('image/')) return;
                if (!imagesDirHandle) {
                    alert('Please select an images folder (section 2) first.');
                    return;
                }
                const uid = parseInt(tr.dataset.id);
                try {
                    const stmt = db.prepare("SELECT name, image, image_2, image_3 FROM entities WHERE id = ?");
                    stmt.bind([uid]);
                    if (!stmt.step()) { stmt.free(); return; }
                    const row = stmt.getAsObject();
                    stmt.free();
                    const ext = file.name.split('.').pop() || 'png';
                    const randomId = Math.random().toString(36).substring(2, 10);
                    const safeName = String(row.name).replace(/[\\/:*?"<>|]/g, '_').trim();
                    const filename = `${safeName}_${randomId}.${ext}`;
                    const blob = new Blob([await file.arrayBuffer()], { type: file.type });
                    await saveImageFS(blob, filename);
                    let col;
                    let oldFile = null;
                    if (!row.image) {
                        col = 'image';
                    } else if (!row.image_2) {
                        col = 'image_2';
                    } else {
                        col = 'image_3';
                        if (row.image_3) oldFile = row.image_3;
                    }
                    if (oldFile) await deleteImageFS(oldFile);
                    db.run(`UPDATE entities SET ${col} = ?, modified_at = CURRENT_TIMESTAMP WHERE id = ?;`, [filename, uid]);
                    updateTable();
                    showNotification('Entity "' + row.name + '" image updated', 'warning');
                } catch (err) {
                    alert('Error: ' + err.message);
                }
            });
        });

        // Load preview thumbs asynchronously
        container.querySelectorAll('.view-img').forEach(img => {
            (async () => {
                try {
                    const url = await getImageURL(img.dataset.file);
                    img.src = url;
                } catch (_) {}
            })();
            img.addEventListener('click', () => {
                const entityId = parseInt(img.dataset.id);
                const idx = imageNavList.findIndex(item => item.id === entityId);
                if (idx !== -1) {
                    showImageModalByIndex(idx);
                }
            });
        });

        // Pagination controls
        container.querySelectorAll('.page-btn').forEach(btn => {
            btn.addEventListener('click', function() {
                const pg = this.dataset.page;
                if (pg === 'prev') { if (currentPage > 1) currentPage--; }
                else if (pg === 'next') { if (currentPage < totalPages) currentPage++; }
                else { currentPage = parseInt(pg); }
                updateTable();
            });
        });
        const sizeSelect = container.querySelector('.page-size-select');
        if (sizeSelect) {
            sizeSelect.addEventListener('change', function() {
                pageSize = parseInt(this.value);
                currentPage = 1;
                updateTable();
            });
        }
    } catch (e) {
        document.getElementById('tableContainer').innerHTML = `<p style="color:#e74c3c">Error: ${e.message}</p>`;
    }
}

function normalizeCompare(str) {
    return str.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function getExistingNormalizedNames() {
    const result = db.exec("SELECT name FROM entities");
    if (!result.length) return new Set();
    const set = new Set();
    for (const row of result[0].values) {
        const parts = row[0].split('|');
        for (const part of parts) {
            set.add(normalizeCompare(part));
        }
    }
    return set;
}

function findDuplicateNames(inputName, existingSet) {
    const parts = inputName.split('|').map(s => s.trim()).filter(s => s.length > 0);
    return parts.filter(p => existingSet.has(normalizeCompare(p)));
}

// Action Trigger: Insert new text input records execution
document.getElementById('insertBtn').addEventListener('click', () => {
    const nameInput = document.getElementById('nameInput');
    const name = nameInput.value.trim();

    if (!name) {
        alert("Please enter a name.");
        return;
    }

    const existingSet = getExistingNormalizedNames();
    const duplicates = findDuplicateNames(name, existingSet);
    if (duplicates.length > 0) {
        const msg = duplicates.length === 1
            ? `The name "${duplicates[0]}" already exists. Do you want to add it anyway?`
            : `The following names already exist: ${duplicates.map(d => `"${d}"`).join(', ')}. Do you want to add them anyway?`;
        if (!confirm(msg)) return;
    }

    db.run("INSERT INTO entities (name) VALUES (?);", [name]);
    const newId = db.exec("SELECT last_insert_rowid();");
    const entityId = newId[0].values[0][0];

    // Save feature values
    const values = getFeatureValues();
    saveEntityFeatures(entityId, values);

    // Save tag components
    const tagIds = getSelectedTagIds();
    saveEntityTags(entityId, tagIds);

    // Save custom field lists definitions
    const fieldVals = getCustomFieldValues();
    saveFieldValues(entityId, fieldVals);

    nameInput.value = '';
    renderFeatureInputs();
    renderTagCheckboxes();
    renderFieldInputs();
    updateTable();
    showNotification('Entity "' + name + '" created', 'success');
});

document.getElementById('clearInsertBtn').addEventListener('click', () => {
    document.getElementById('nameInput').value = '';
    renderFeatureInputs();
    renderTagCheckboxes();
    renderFieldInputs();
});

// Trigger Action: Delete existing table entries
document.getElementById('clearBtn').addEventListener('click', () => {
    db.run("DELETE FROM entity_field_value;");
    db.run("DELETE FROM entity_field_value_multi;");
    db.run("DELETE FROM entity_tags;");
    db.run("DELETE FROM entity_features;");
    db.run("DELETE FROM entities;");
    updateTable();
    showNotification('All entities deleted', 'error');
});

// EXPORT ACTION: Generate .sqlite database package file directly
function getAppName() {
    const input = document.getElementById('appNameInput');
    return input ? input.value.trim() || 'My App' : 'My App';
}

function downloadDatabase() {
    const binaryArray = db.export();
    const blob = new Blob([binaryArray], { type: "application/x-sqlite3" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    const appName = getAppName().replace(/[^a-zA-Z0-9_\-]/g, '_');
    a.download = `${appName}_${year}-${month}-${day}_${hours}-${minutes}-${seconds}.sqlite`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

document.getElementById('downloadBtn').addEventListener('click', downloadDatabase);

// Fetch user preferences configuration variables data references
function loadConfiguration() {
    const res = db.exec("SELECT value FROM configuration WHERE key = 'app_name';");
    const name = (res.length > 0 && res[0].values.length > 0) ? res[0].values[0][0] : 'My App';
    document.getElementById('appNameInput').value = name;
    document.title = name;
}

// Apply real time changes to application tracking headers updates
document.getElementById('appNameInput').addEventListener('input', function() {
    db.run("INSERT OR REPLACE INTO configuration (key, value) VALUES ('app_name', ?);", [this.value]);
    document.title = this.value.trim() || 'My App';
});

let pendingSave = false;
window.addEventListener('beforeunload', (e) => {
    e.preventDefault();
    e.returnValue = '';
    pendingSave = true;
    setTimeout(() => {
        if (pendingSave) {
            pendingSave = false;
            if (confirm('Would you like to download a backup copy of your database before exiting?')) {
                downloadDatabase();
            }
        }
    }, 100);
});

document.getElementById('setupBtn').addEventListener('click', async () => {
    await pickImageDir();
    document.getElementById('uploadInput').click();
});

// IMPORT CONTROL ACTION: Parse target binary files stream input data array
document.getElementById('uploadInput').addEventListener('change', function(e) {
    const file = e.target.files[0];
    if (!file) return;

    document.getElementById('loadingSpinner').style.display = 'flex';

    const reader = new FileReader();
    reader.onload = function() {
        const Uints = new Uint8Array(reader.result);

        if (db) db.close();

        db = new SQL.Database(Uints);

    db.run("CREATE TABLE IF NOT EXISTS entities (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, image TEXT, image_2 TEXT, image_3 TEXT, date TIMESTAMP DEFAULT CURRENT_TIMESTAMP, modified_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);");
        try { db.run("ALTER TABLE entities ADD COLUMN image_2 TEXT;"); } catch(e) {}
        try { db.run("ALTER TABLE entities ADD COLUMN image_3 TEXT;"); } catch(e) {}
        db.run("CREATE TABLE IF NOT EXISTS features (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, factor REAL);");
        db.run("CREATE TABLE IF NOT EXISTS entity_features (entity_id INTEGER, feature_id INTEGER, value TEXT, PRIMARY KEY (entity_id, feature_id));");
        db.run("CREATE TABLE IF NOT EXISTS tags (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, factor REAL, description TEXT);");
        db.run("CREATE TABLE IF NOT EXISTS entity_tags (entity_id INTEGER, tag_id INTEGER, PRIMARY KEY (entity_id, tag_id));");
        db.run("CREATE TABLE IF NOT EXISTS custom_fields (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, description TEXT, type TEXT CHECK(type IN ('text','single_list','multi_list')));");
        db.run("CREATE TABLE IF NOT EXISTS field_options (id INTEGER PRIMARY KEY AUTOINCREMENT, field_id INTEGER REFERENCES custom_fields(id), value TEXT, factor REAL);");
        db.run("CREATE TABLE IF NOT EXISTS entity_field_value (entity_id INTEGER, field_id INTEGER, value TEXT, PRIMARY KEY (entity_id, field_id));");
        db.run("CREATE TABLE IF NOT EXISTS entity_field_value_multi (entity_id INTEGER, field_id INTEGER, option_id INTEGER, PRIMARY KEY (entity_id, field_id, option_id));");
        db.run("CREATE TABLE IF NOT EXISTS configuration (key TEXT PRIMARY KEY, value TEXT);");
        migrateFieldValues();
        const featuresCount = db.exec("SELECT COUNT(*) as cnt FROM features;");
        if (featuresCount.length === 0 || featuresCount[0].values[0][0] === 0) {
            db.run("INSERT INTO features (name, factor) VALUES ('Height', 1.0);");
        }
        const appCfg = db.exec("SELECT value FROM configuration WHERE key = 'app_name';");
        if (appCfg.length === 0 || appCfg[0].values.length === 0) {
            db.run("INSERT INTO configuration (key, value) VALUES ('app_name', 'My App');");
        }

        loadFeatures();
        loadTags();
        loadCustomFields();
        loadConfiguration();
        renderFilters();
        updateTable();
        document.getElementById('sidebar').classList.remove('open');
        document.getElementById('loadingSpinner').style.display = 'none';
    };
    reader.readAsArrayBuffer(file);
});

// UI Panel collapsible behaviors control listeners
document.querySelectorAll('.card > h3').forEach(h3 => {
    h3.addEventListener('click', () => {
        h3.parentElement.classList.toggle('collapsed');
    });
});