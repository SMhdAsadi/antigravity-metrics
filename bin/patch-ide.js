import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import picocolors from 'picocolors';
import ora from 'ora';
import prompts from 'prompts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const { blue, green, red, yellow } = picocolors;

function idePaths(appDir) {
    const outDir = path.join(appDir, 'out');
    const mainJsPath = path.join(outDir, 'main.js');
    return {
        outDir,
        mainJsPath,
        mainJsBak: mainJsPath + '.metrics-bak'
    };
}

function getIdeCandidatePaths() {
    const candidates = [];
    const platform = os.platform();

    if (platform === 'darwin') {
        candidates.push('/Applications/Antigravity IDE.app');
        candidates.push(path.join(os.homedir(), 'Applications', 'Antigravity IDE.app'));
    } else if (platform === 'win32') {
        if (process.env.LOCALAPPDATA) {
            candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Antigravity IDE'));
            candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'antigravity-ide'));
            candidates.push(path.join(process.env.LOCALAPPDATA, 'Antigravity IDE'));
        }
        if (process.env.PROGRAMFILES) {
            candidates.push(path.join(process.env.PROGRAMFILES, 'Antigravity IDE'));
            candidates.push(path.join(process.env.PROGRAMFILES, 'antigravity-ide'));
        }
        if (process.env['PROGRAMFILES(X86)']) {
            candidates.push(path.join(process.env['PROGRAMFILES(X86)'], 'Antigravity IDE'));
        }
    } else {
        candidates.push(path.join(os.homedir(), 'Downloads', 'Antigravity IDE'));
        candidates.push('/opt/Antigravity IDE');
        candidates.push('/opt/antigravity-ide');
        candidates.push('/usr/share/antigravity');
        candidates.push('/usr/share/antigravity-ide');
        candidates.push(path.join(os.homedir(), '.local', 'share', 'antigravity-ide'));
    }
    return candidates;
}

export function resolveIdeAppDir(inputPath) {
    if (!inputPath || !fs.existsSync(inputPath)) return null;
    let candidate = inputPath;

    if (fs.existsSync(path.join(candidate, 'out', 'main.js'))) {
        return candidate;
    }
    const macAppDir = path.join(candidate, 'Contents', 'Resources', 'app');
    if (fs.existsSync(path.join(macAppDir, 'out', 'main.js'))) {
        return macAppDir;
    }
    const standardAppDir = path.join(candidate, 'resources', 'app');
    if (fs.existsSync(path.join(standardAppDir, 'out', 'main.js'))) {
        return standardAppDir;
    }
    return null;
}

export function detectIdeAppPath() {
    for (const c of getIdeCandidatePaths()) {
        const resolved = resolveIdeAppDir(c);
        if (resolved) return resolved;
    }
    return null;
}

export function hasIdeBackup(appDir) {
    if (!appDir) return false;
    const { mainJsPath, mainJsBak } = idePaths(appDir);
    let hasImport = false;
    if (fs.existsSync(mainJsPath)) {
        try {
            const code = fs.readFileSync(mainJsPath, 'utf8');
            hasImport = code.includes("import './antigravity-metrics-main.js';");
        } catch (_) {}
    }
    return fs.existsSync(mainJsBak) || hasImport;
}

export async function getIdeAppPath() {
    const detected = detectIdeAppPath();
    if (detected) {
        console.log(blue(`ℹ Found Antigravity IDE installation at:`));
        console.log(`  ${detected}\n`);
        return detected;
    }

    console.log(yellow(`⚠ Could not automatically find Antigravity IDE.`));
    const response = await prompts({
        type: 'text',
        name: 'customPath',
        message: 'Please enter the path to your Antigravity IDE directory:'
    });

    if (!response.customPath) {
        console.error(red('\n✖ No path entered. Aborting.\n'));
        process.exit(1);
    }

    const resolved = resolveIdeAppDir(response.customPath);
    if (!resolved) {
        console.error(red(`\n✖ Could not find valid IDE resources in "${response.customPath}". Aborting.\n`));
        process.exit(1);
    }
    return resolved;
}

export async function restoreIde(appDir, { exitOnError = true } = {}) {
    const { outDir, mainJsPath, mainJsBak } = idePaths(appDir);

    if (!hasIdeBackup(appDir)) {
        console.error(red('✖ No backup found to restore for Antigravity IDE.\n'));
        if (exitOnError) process.exit(1);
        return false;
    }

    const spinner = ora('Restoring original Antigravity IDE files...').start();
    try {
        if (fs.existsSync(mainJsBak)) {
            fs.copyFileSync(mainJsBak, mainJsPath);
            fs.unlinkSync(mainJsBak);
        } else if (fs.existsSync(mainJsPath)) {
            let code = fs.readFileSync(mainJsPath, 'utf8');
            if (code.includes("import './antigravity-metrics-main.js';")) {
                code = code.replace("import './antigravity-metrics-main.js';\n", '');
                code = code.replace("import './antigravity-metrics-main.js';", '');
                fs.writeFileSync(mainJsPath, code, 'utf8');
            }
        }

        const filesToClean = [
            path.join(outDir, 'antigravity-metrics-main.js'),
            path.join(outDir, 'antigravity-metrics-client.js')
        ];
        for (const f of filesToClean) {
            fs.rmSync(f, { force: true });
        }

        spinner.succeed('Successfully restored original Antigravity IDE!\n');
        return true;
    } catch (e) {
        spinner.fail('Failed to restore Antigravity IDE.');
        console.error(red(e.message));
        if (exitOnError) process.exit(1);
        return false;
    }
}

export async function patchIde(appDir, { exitOnError = true } = {}) {
    const { outDir, mainJsPath, mainJsBak } = idePaths(appDir);
    const spinner = ora('Checking permissions and backing up IDE files...').start();
    let failLabel = 'Permission Denied.';

    try {
        fs.accessSync(outDir, fs.constants.W_OK);
        fs.accessSync(mainJsPath, fs.constants.W_OK);

        failLabel = 'Failed to create backup.';
        if (!fs.existsSync(mainJsBak) && fs.existsSync(mainJsPath)) {
            fs.copyFileSync(mainJsPath, mainJsBak);
        }

        failLabel = 'Failed to copy metrics scripts.';
        spinner.text = 'Copying metrics telemetry engine and injection scripts...';
        fs.copyFileSync(path.join(__dirname, 'ide-client.js'), path.join(outDir, 'antigravity-metrics-client.js'));
        fs.copyFileSync(path.join(__dirname, 'ide-main.js'), path.join(outDir, 'antigravity-metrics-main.js'));

        failLabel = 'Injection into Antigravity IDE failed.';
        spinner.text = 'Injecting metrics hook into main.js...';
        let mainCode = fs.readFileSync(mainJsPath, 'utf8');
        const importHook = "import './antigravity-metrics-main.js';\n";

        if (!mainCode.includes("import './antigravity-metrics-main.js';")) {
            mainCode = importHook + mainCode;
            fs.writeFileSync(mainJsPath, mainCode, 'utf8');
        }

        spinner.succeed('Successfully patched Antigravity IDE!');
        console.log(green('\n✨ Antigravity Metrics has been enabled for Antigravity IDE.'));
        console.log(green('✨ Please restart Antigravity IDE to see real-time chat telemetry.\n'));
        return true;
    } catch (e) {
        spinner.fail(failLabel);
        console.error(red('\nError: ' + e.message));
        if (exitOnError) process.exit(1);
        return false;
    }
}
