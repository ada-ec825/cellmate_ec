import axios from 'axios';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import FormData from 'form-data';
import { ProviderConfig } from './configParser';
import { getSttPort } from './localServer'; 

/**
 * Send audio to corresponding STT service and return transcribed text
 * @param audioBase64 Base64 encoded audio file
 * @param cfg         Config object returned by getProviderConfig()
 */
export async function sendAudioToApi(
  audioBase64: string,
  cfg: ProviderConfig
): Promise<string> {
  if (cfg.provider === 'local') {
    const port = getSttPort();
    const requestBody: any = {
      audio: audioBase64,
      model: 'tiny'
    };
    if (cfg.language) {
      requestBody.language = cfg.language;
    }

    const resp = await fetch(`http://127.0.0.1:${port}/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });

    if (!resp.ok) {
      const errorText = await resp.text().catch(() => resp.statusText);
      throw new Error(`Local speech-to-text request failed (${resp.status}): ${errorText}`);
    }

    const data = await resp.json() as { text?: string };
    return data.text || '';
  }

  if (cfg.provider === 'openai') {
    const headers = { Authorization: `Bearer ${cfg.openaiApiKey}` };
    const tmp = path.join(os.tmpdir(), `cellmate-audio-${process.pid}-${Date.now()}.webm`);
    fs.writeFileSync(tmp, Buffer.from(audioBase64, 'base64'));

    try {
      const form = new FormData();
      form.append('model', cfg.openaiModel || 'whisper-1');
      form.append('file', fs.createReadStream(tmp));
      if (cfg.language) {
        form.append('language', cfg.language);
      }

      const res = await axios.post(
        'https://api.openai.com/v1/audio/transcriptions',
        form,
        { headers: { ...headers, ...form.getHeaders() } }
      );

      return res.data.text || '';
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }

  if (cfg.provider === 'azure') {
    const language = cfg.language || 'en-US';
    const endpoint = `https://${cfg.azureRegion}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=${language}`;
    const headers = {
      'Ocp-Apim-Subscription-Key': cfg.azureApiKey,
      'Content-Type': 'audio/ogg; codecs=opus'
    };
    const bin = Buffer.from(audioBase64, 'base64');
    const res = await axios.post(endpoint, bin, { headers });
    return res.data.DisplayText || '';
  }

  throw new Error(`Unsupported provider: ${cfg.provider}`);
}
