import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import picocolors from 'picocolors';
import ora from 'ora';
import prompts from 'prompts';
import * as asar from '@electron/asar';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const { blue, green, red, yellow } = picocolors;

const PATCH_START = '/* ANTIGRAVITY METRICS PATCH */';
const PATCH_END = '/* END ANTIGRAVITY METRICS PATCH */';
const ANCHOR = 'void win.loadURL(url);';
const PATCH_BLOCK = /\/\* ANTIGRAVITY METRICS PATCH \*\/[\s\S]*?\/\* END ANTIGRAVITY METRICS PATCH \*\//;

function readUtils(asarFile) {
    asar.uncache(asarFile);
    return asar.extractFile(asarFile, 'dist/utils.js').toString('utf8');
}

function stripPatch(code) {
    return PATCH_BLOCK.test(code) ? code.replace(PATCH_BLOCK, ANCHOR) : null;
}

function getAppCandidatePaths() {
    const candidates = [];
    const platform = os.platform();

    if (platform === 'darwin') {
        candidates.push('/Applications/Antigravity.app/Contents/Resources/app.asar');
        candidates.push(path.join(os.homedir(), 'Applications', 'Antigravity.app', 'Contents', 'Resources', 'app.asar'));
    } else if (platform === 'win32') {
        if (process.env.LOCALAPPDATA) {
            candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Antigravity', 'resources', 'app.asar'));
            candidates.push(path.join(process.env.LOCALAPPDATA, 'Antigravity', 'resources', 'app.asar'));
        }
        if (process.env.PROGRAMFILES) {
            candidates.push(path.join(process.env.PROGRAMFILES, 'Antigravity', 'resources', 'app.asar'));
        }
        if (process.env['PROGRAMFILES(X86)']) {
            candidates.push(path.join(process.env['PROGRAMFILES(X86)'], 'Antigravity', 'resources', 'app.asar'));
        }
    } else {
        candidates.push('/opt/Antigravity/resources/app.asar');
        candidates.push('/opt/antigravity/resources/app.asar');
        candidates.push('/usr/share/antigravity/resources/app.asar');
        candidates.push(path.join(os.homedir(), '.local', 'share', 'antigravity', 'resources', 'app.asar'));
    }
    return candidates;
}

export function detectAppAsarPath() {
    return getAppCandidatePaths().find(c => fs.existsSync(c)) || null;
}

export function hasAppBackup(asarPath) {
    return asarPath ? fs.existsSync(asarPath + '.metrics-bak') : false;
}

export async function getAppAsarPath() {
    const detected = detectAppAsarPath();
    if (detected) {
        console.log(blue(`ℹ Found Antigravity installation at:`));
        console.log(`  ${detected}\n`);
        return detected;
    }

    console.log(yellow(`⚠ Could not find Antigravity (App) at default location.`));
    const response = await prompts({
        type: 'text',
        name: 'customPath',
        message: 'Please enter the full path to app.asar:'
    });

    if (!response.customPath || !fs.existsSync(response.customPath)) {
        console.error(red('\n✖ Invalid path. Aborting.\n'));
        process.exit(1);
    }
    return response.customPath;
}

export async function restoreApp(asarPath, { exitOnError = true } = {}) {
    const backupPath = asarPath + '.metrics-bak';
    const extractDir = path.join(path.dirname(asarPath), 'app-extracted-metrics-temp');

    const spinner = ora('Restoring Antigravity app.asar...').start();
    try {
        if (fs.existsSync(backupPath)) {
            fs.copyFileSync(backupPath, asarPath);
            asar.uncache(asarPath);
            fs.unlinkSync(backupPath);
            spinner.succeed('Successfully restored original Antigravity from backup!\n');
            return true;
        }

        // In-place clean if backup does not exist
        const currentUtils = readUtils(asarPath);
        if (!currentUtils.includes(PATCH_START)) {
            spinner.succeed('Antigravity App is not currently patched with metrics.\n');
            return true;
        }

        fs.rmSync(extractDir, { recursive: true, force: true });
        asar.extractAll(asarPath, extractDir);
        const utilsPath = path.join(extractDir, 'dist', 'utils.js');
        const clientPath = path.join(extractDir, 'dist', 'antigravity-metrics-client.js');
        const cleanUtils = stripPatch(currentUtils);
        fs.writeFileSync(utilsPath, cleanUtils);
        if (fs.existsSync(clientPath)) fs.unlinkSync(clientPath);

        await asar.createPackage(extractDir, asarPath);
        asar.uncache(asarPath);
        fs.rmSync(extractDir, { recursive: true, force: true });

        spinner.succeed('Successfully removed metrics patch from Antigravity!\n');
        return true;
    } catch (e) {
        spinner.fail('Failed to restore Antigravity.');
        console.error(red(e.message));
        fs.rmSync(extractDir, { recursive: true, force: true });
        if (exitOnError) process.exit(1);
        return false;
    }
}

export async function patchApp(asarPath, { exitOnError = true } = {}) {
    const backupPath = asarPath + '.metrics-bak';
    const extractDir = path.join(path.dirname(asarPath), 'app-extracted-metrics-temp');
    const spinner = ora('Checking permissions and backing up Antigravity App...').start();
    let failLabel = 'Permission Denied.';

    try {
        fs.accessSync(path.dirname(asarPath), fs.constants.W_OK);

        failLabel = 'Failed to read app.asar.';
        const currentUtils = readUtils(asarPath);

        if (!currentUtils.includes(PATCH_START)) {
            if (!fs.existsSync(backupPath)) {
                fs.copyFileSync(asarPath, backupPath);
                asar.uncache(backupPath);
            }
        } else {
            spinner.text = 'Updating existing Metrics patch to latest version...';
        }

        failLabel = 'Failed to extract ASAR.';
        spinner.text = 'Extracting app.asar...';
        fs.rmSync(extractDir, { recursive: true, force: true });
        asar.extractAll(asarPath, extractDir);

        const utilsPath = path.join(extractDir, 'dist', 'utils.js');
        const clientDest = path.join(extractDir, 'dist', 'antigravity-metrics-client.js');

        failLabel = 'Injection failed.';
        spinner.text = 'Injecting Antigravity Metrics engine...';
        let utilsCode = fs.readFileSync(utilsPath, 'utf8');

        // Clean any existing metrics patch first
        if (PATCH_BLOCK.test(utilsCode)) {
            utilsCode = utilsCode.replace(PATCH_BLOCK, ANCHOR);
        }

        const payload = fs.readFileSync(path.join(__dirname, 'payload.js'), 'utf8');
        if (!utilsCode.includes(ANCHOR)) {
            throw new Error('Injection anchor not found. The app version might be unsupported.');
        }

        utilsCode = utilsCode.replace(ANCHOR, () => payload.trim());
        fs.writeFileSync(utilsPath, utilsCode);

        // Copy client script inside ASAR
        fs.copyFileSync(path.join(__dirname, 'ide-client.js'), clientDest);

        failLabel = 'Failed to repack ASAR.';
        spinner.text = 'Repacking app.asar...';
        await asar.createPackage(extractDir, asarPath);
        asar.uncache(asarPath);
        fs.rmSync(extractDir, { recursive: true, force: true });

        spinner.succeed('Successfully patched Antigravity App!');
        console.log(green('\n✨ Antigravity Metrics has been enabled for Standalone App.'));
        console.log(green('✨ Please restart Antigravity to see real-time chat telemetry.\n'));
        return true;
    } catch (e) {
        spinner.fail(failLabel);
        console.error(red('\nError: ' + e.message));
        fs.rmSync(extractDir, { recursive: true, force: true });
        if (exitOnError) process.exit(1);
        return false;
    }
}
