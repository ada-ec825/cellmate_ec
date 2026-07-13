import * as vscode from 'vscode';

const CONFIG_SECTION = 'CellMate';
const LEGACY_CONFIG_SECTION = 'jupyterAiFeedback';

export type ProviderType = 'local' | 'openai' | 'azure';

export interface ProviderConfig {
  provider: ProviderType;
  language?: string;

  // OpenAI
  openaiApiKey?: string;
  openaiModel?: string;

  // Azure
  azureApiKey?: string;
  azureRegion?: string;
}

export function getCellMateSetting<T>(key: string, defaultValue?: T): T | undefined {
  const value = vscode.workspace.getConfiguration(CONFIG_SECTION).get<T>(key);
  if (value !== undefined && value !== '') {
    return value;
  }

  const legacyValue = vscode.workspace.getConfiguration(LEGACY_CONFIG_SECTION).get<T>(key);
  if (legacyValue !== undefined && legacyValue !== '') {
    return legacyValue;
  }

  return defaultValue;
}

export function getProviderConfig(): ProviderConfig {
  const provider = getCellMateSetting<ProviderType>('speechProvider', 'local') || 'local';

  if (provider === 'local') {
    const language = getCellMateSetting<string>('speechLocal.language');
    return {
      provider,
      language: language || undefined
    };
  }

  if (provider === 'openai') {
    const openaiApiKey = getCellMateSetting<string>('speechOpenai.apiKey');
    if (!openaiApiKey) {
      throw new Error('Missing OpenAI API key. Please set CellMate.speechOpenai.apiKey.');
    }
    const language = getCellMateSetting<string>('speechOpenai.language');
    return {
      provider,
      language: language || undefined,
      openaiApiKey,
      openaiModel: getCellMateSetting<string>('speechOpenai.modelId', 'whisper-1') || 'whisper-1'
    };
  }

  if (provider === 'azure') {
    const azureApiKey = getCellMateSetting<string>('speechAzure.apiKey');
    const azureRegion = getCellMateSetting<string>('speechAzure.region');
    if (!azureApiKey || !azureRegion) {
      throw new Error(
        'Missing Azure API key or region. Please set CellMate.speechAzure.apiKey and CellMate.speechAzure.region.'
      );
    }
    return {
      provider,
      language: getCellMateSetting<string>('speechAzure.language', 'en-US') || 'en-US',
      azureApiKey,
      azureRegion
    };
  }

  throw new Error('Unsupported speechProvider');
}
