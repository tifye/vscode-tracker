const vscode = require('vscode')
const util = require('util')
const path = require('path')
const child_process = require('child_process')
const exec = util.promisify(child_process.exec)

/** @type {Set<string>} */
const ignoredFiles = new Set()

/** @type {NodeJS.Timeout | undefined} */
let statePollInterval

/** State of activity
 * @typedef {Object} State
 * @property {string} workspace
 * @property {string} fileName
 * @property {string} language
 * @property {number} row
 * @property {number} col
 * @property {string} viewChunk
 */

/** @type {State} */
let prevState = {
    workspace: '',
    fileName: '',
    language: '',
    row: 0,
    col: 0,
    viewChunk: '',
}

/** @type {AbortController | undefined} */
let updateStateAbortController

/** @type {vscode.OutputChannel} */
let chan

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    if (process.platform !== 'win32') {
        vscode.window.showErrorMessage(
            'Activity tracker only supported on Windows.',
        )
        return
    }

    chan = vscode.window.createOutputChannel('Activity Tracker')

    const target = context.globalState.get('target')
    context.secrets.get('token').then((token) => {
        if (token === undefined) {
            chan.appendLine('No token found')
            return
        }

        setInterval(() => pollState(target, token), 2000)
    })

    const disposeSetTarget = vscode.commands.registerCommand(
        'activity-tracker.setTarget',
        () => handleSetTargetCmd(context),
    )

    const disposeSetToken = vscode.commands.registerCommand(
        'activity-tracker.setToken',
        () => handleSetTokenCmd(context),
    )

    context.subscriptions.push(
        disposeSetTarget,
        disposeSetToken,
        {
            dispose: chan.dispose,
        },
        {
            dispose: () => clearInterval(statePollInterval),
        },
    )
}

// This method is called when your extension is deactivated
function deactivate() {
    clearInterval(statePollInterval)
    if (chan !== undefined) {
        chan.dispose()
    }
    if (updateStateAbortController !== undefined) {
        updateStateAbortController.abort()
    }
}

/**
 *
 * @param {string} target
 * @param {string} token
 * @returns
 */
async function pollState(target, token) {
    const doc = vscode.window.activeTextEditor.document
    const sel = vscode.window.activeTextEditor.selection
    const view = doc.getText(getViewRange(sel, doc.lineCount))

    /** @type {State} */
    const curState = {
        workspace: vscode.workspace.name,
        fileName: doc.fileName,
        language: doc.languageId,
        row: sel.active.line,
        col: sel.active.character,
        viewChunk: view,
    }

    if (shallowEqual(prevState, curState)) {
        return
    }

    const didChangeFile = prevState.fileName !== curState.fileName
    prevState = curState

    chan.appendLine('Updating state')

    if (updateStateAbortController !== undefined) {
        updateStateAbortController.abort()
    }

    updateStateAbortController = new AbortController()

    if (ignoredFiles.has(doc.fileName)) {
        chan.appendLine(doc.fileName + ' is ignored (looked up from cache)')
        return
    }

    if (didChangeFile) {
        const dir = path.dirname(doc.fileName)
        const cmd = `git check-ignore ${doc.fileName} -q`
        let isIgnored
        try {
            await exec(cmd, {
                signal: updateStateAbortController.signal,
                cwd: dir,
            })
        } catch (err) {
            isIgnored = err.code === undefined || err.code !== 1
        }

        if (isIgnored === undefined || isIgnored === true) {
            chan.appendLine(doc.fileName + ' is ignored')
            ignoredFiles.add(doc.fileName)
            return
        }
    }

    const url = target
    try {
        const resp = await fetch(url, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(curState),
            signal: updateStateAbortController.signal,
        })

        if (!resp.ok) {
            throw new Error(await resp.text())
        }
    } catch (err) {
        chan.appendLine(`Something went wrong: ${err}`)
    }
}

/**
 *
 * @param {vscode.Selection} selection
 * @param {number} lineCount
 * @returns {vscode.Range}
 */
function getViewRange(selection, lineCount) {
    const range = 5
    const totalRange = range * 2 + 1

    if (lineCount < totalRange) {
        return new vscode.Range(
            new vscode.Position(0, 0),
            new vscode.Position(lineCount, 0),
        )
    }

    let startLine = Math.max(0, selection.active.line - range)
    if (lineCount - startLine >= totalRange) {
        return new vscode.Range(
            new vscode.Position(startLine, 0),
            new vscode.Position(startLine + totalRange - 1, 0),
        )
    }

    startLine = startLine - Math.abs(lineCount - startLine - totalRange)
    return new vscode.Range(
        new vscode.Position(startLine, 0),
        new vscode.Position(startLine + totalRange - 1, 0),
    )
}

function shallowEqual(objA, objB) {
    const keysA = Object.keys(objA)
    const keysB = Object.keys(objB)

    if (keysA.length !== keysB.length) return false

    for (let key of keysA) {
        if (objA[key] !== objB[key]) return false
    }

    return true
}

/**
 *
 * @param {vscode.ExtensionContext} context
 */
async function handleSetTokenCmd(context) {
    const token = await vscode.window.showInputBox({
        password: true,
        prompt: 'Set authorization bearer token used when making requests to target backend.',
        title: 'Bearer token',
    })

    if (token === undefined || token.trim() === '') {
        vscode.window.showErrorMessage('No token provided.')
        return
    }

    context.secrets.store('token', token)
    const selection = await vscode.window.showInformationMessage(
        'Token updated, extension restart requried.',
        'Reload Window',
    )
    if (selection === 'Reload Window') {
        vscode.commands.executeCommand('workbench.action.reloadWindow')
    }
}

/**
 *
 * @param {vscode.ExtensionContext} context
 */
async function handleSetTargetCmd(context) {
    const target = await vscode.window.showInputBox({
        prompt: 'Set target backend.',
        title: 'Target backend',
    })

    if (target === undefined || target.trim() === '') {
        vscode.window.showErrorMessage('No target provided.')
        return
    }

    context.globalState.update('target', target)
    const selection = await vscode.window.showInformationMessage(
        'Target updated, extension restart requried.',
        'Reload Window',
    )
    if (selection === 'Reload Window') {
        vscode.commands.executeCommand('workbench.action.reloadWindow')
    }
}

module.exports = {
    activate,
    deactivate,
}
