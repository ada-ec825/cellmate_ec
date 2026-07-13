import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import ffmpeg from '@ffmpeg-installer/ffmpeg';

let ffmpegProcess: ChildProcessWithoutNullStreams | null = null;
let outputPath: string = '';
let recordingStartTime: number | null = null;

export function startFFmpegRecording(): boolean {
    if (ffmpegProcess) {
        vscode.window.showWarningMessage('Recording is already in progress.');
        return false;
    }

    outputPath = path.join(os.tmpdir(), `cellmate-recording-${process.pid}-${Date.now()}.ogg`);
    if (fs.existsSync(outputPath)) {
        fs.unlinkSync(outputPath);
    }

    const platform = process.platform;
    let inputArgs: string[] = [];

    if (platform === 'darwin') {
        inputArgs = ['-f', 'avfoundation', '-i', ':0'];
    } else if (platform === 'win32') {
        inputArgs = ['-f', 'dshow', '-i', 'audio=Microphone'];
    } else if (platform === 'linux') {
        inputArgs = ['-f', 'alsa', '-i', 'default'];
    } else {
        vscode.window.showErrorMessage('Unsupported platform for FFmpeg recording.');
        return false;
    }

    const ffmpegArgs = [
        ...inputArgs,
        '-ar', '16000',
        '-ac', '1',
        '-c:a', 'libopus',
        '-b:a', '64k',
        '-vbr', 'on',
        '-f', 'ogg',
        outputPath
    ];

    ffmpegProcess = spawn(ffmpeg.path, ffmpegArgs);

    recordingStartTime = Date.now();

    ffmpegProcess.on('error', err => {
        ffmpegProcess = null;
        recordingStartTime = null;
        vscode.window.showErrorMessage(`FFmpeg failed: ${err.message}`);
    });

    vscode.window.showInformationMessage('🎙️ Recording started...');
    return true;
}

export function stopFFmpegRecording(): Promise<string> {
    return new Promise((resolve, reject) => {
        if (!ffmpegProcess || !recordingStartTime) {
            reject(new Error('No recording is currently running.'));
            return;
        }

        const duration = Date.now() - recordingStartTime;
        const delay = Math.max(1000 - duration, 0);

        setTimeout(() => {
            ffmpegProcess!.on('close', code => {
                ffmpegProcess = null;
                recordingStartTime = null;

                if (fs.existsSync(outputPath)) {
                    vscode.window.showInformationMessage('✅ Recording finished.');
                    resolve(outputPath);
                } else {
                    reject(new Error(`Recording file not found after FFmpeg exit, code: ${code}`));
                }
            });

            ffmpegProcess!.kill('SIGINT');
        }, delay);
    });
}
