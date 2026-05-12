const path = require('path');
const fs = require('fs/promises');

const DATA_FILE = 'notes-data.json';
const BACKUP_FILE = `${DATA_FILE}.bak`;
const TEMP_FILE = `${DATA_FILE}.tmp`;
const CUSTOM_DATA_DIR = 'C:\\Users\\viky1\\Downloads\\notes_roam';
const USER_BACKUP_DIR = 'C:\\Users\\viky1\\OneDrive\\Documents';

function getDataFilePath() {
  return path.join(CUSTOM_DATA_DIR, DATA_FILE);
}

function getBackupFilePath() {
  return path.join(CUSTOM_DATA_DIR, BACKUP_FILE);
}

function getTempFilePath() {
  return path.join(CUSTOM_DATA_DIR, TEMP_FILE);
}

function getTimestampForFile(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function getUserBackupFilePath(date = new Date()) {
  return path.join(USER_BACKUP_DIR, `roam-notes-backup-${getTimestampForFile(date)}.json`);
}

function collectStats(data) {
  const pages = data?.pages && typeof data.pages === 'object' ? Object.values(data.pages) : [];
  let blocks = 0;

  function walk(items) {
    for (const item of items || []) {
      blocks += 1;
      walk(item.children);
    }
  }

  for (const page of pages) {
    walk(page.blocks);
  }

  return { pages: pages.length, blocks };
}

async function readCurrentStats(filePath) {
  try {
    const current = await readDataFile(filePath);
    return current.empty ? null : collectStats(current.data);
  } catch {
    return null;
  }
}

function isSevereShrink(currentStats, nextStats) {
  if (!currentStats) return false;
  const pagesCollapsed = currentStats.pages >= 20 && nextStats.pages < currentStats.pages * 0.5;
  const blocksCollapsed = currentStats.blocks >= 100 && nextStats.blocks < currentStats.blocks * 0.5;
  return pagesCollapsed || blocksCollapsed;
}

async function readDataFile(filePath) {
  const text = await fs.readFile(filePath, 'utf8');
  if (!text || text.trim() === '' || text.trim() === 'null') {
    return { empty: true, data: null };
  }
  return { empty: false, data: JSON.parse(text) };
}

async function copyUsableBackup(sourcePath, backupPath) {
  try {
    const current = await readDataFile(sourcePath);
    if (!current.empty) {
      await fs.copyFile(sourcePath, backupPath);
    }
  } catch {
    // A backup should never block saving the user's current data.
  }
}

async function ensureDataFile() {
  const filePath = getDataFilePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.access(filePath);
  } catch {
    await fs.writeFile(filePath, JSON.stringify(null), 'utf8');
  }
  return filePath;
}

async function loadData() {
  const filePath = await ensureDataFile();
  const backupPath = getBackupFilePath();
  try {
    const current = await readDataFile(filePath);
    if (!current.empty) {
      return { ok: true, data: current.data };
    }

    const backup = await readDataFile(backupPath);
    if (!backup.empty) {
      await fs.copyFile(backupPath, filePath);
      return { ok: true, data: backup.data };
    }

    return { ok: true, data: null };
  } catch (err) {
    try {
      const backup = await readDataFile(backupPath);
      if (!backup.empty) {
        await fs.copyFile(backupPath, filePath);
        return { ok: true, data: backup.data };
      }
    } catch {
      // Report the original load error if both primary and backup fail.
    }
    return { ok: false, error: err.message };
  }
}

async function saveData(data, options = {}) {
  const filePath = await ensureDataFile();
  const backupPath = getBackupFilePath();
  const tempPath = getTempFilePath();
  try {
    const json = JSON.stringify(data, null, 2);
    if (!json || json.trim() === '' || json.trim() === 'null') {
      throw new Error('Refusing to save empty notes data');
    }
    const currentStats = await readCurrentStats(filePath);
    const nextStats = collectStats(data);
    if (!options.allowDestructive && isSevereShrink(currentStats, nextStats)) {
      throw new Error(
        `Refusing stale save: current file has ${currentStats.pages} pages/${currentStats.blocks} blocks, ` +
        `incoming data has ${nextStats.pages} pages/${nextStats.blocks} blocks`
      );
    }
    await copyUsableBackup(filePath, backupPath);
    await fs.writeFile(tempPath, json, 'utf8');
    await fs.rename(tempPath, filePath);
    return { ok: true };
  } catch (err) {
    try {
      await fs.rm(tempPath, { force: true });
    } catch {
      // Ignore cleanup errors; the save error is more useful.
    }
    return { ok: false, error: err.message };
  }
}

async function createUserBackup(data, options = {}) {
  if (data !== undefined) {
    const saveResult = await saveData(data, options);
    if (!saveResult.ok) return saveResult;
  } else {
    await ensureDataFile();
  }

  const filePath = getDataFilePath();
  const backupPath = getUserBackupFilePath();

  try {
    const current = await readDataFile(filePath);
    if (current.empty) {
      throw new Error('No notes data is available to back up');
    }

    await fs.mkdir(path.dirname(backupPath), { recursive: true });
    await fs.copyFile(filePath, backupPath);
    return { ok: true, path: backupPath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  createUserBackup,
  ensureDataFile,
  getDataFilePath,
  loadData,
  saveData
};
