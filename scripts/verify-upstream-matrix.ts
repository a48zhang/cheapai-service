import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Q07 live-client harness.
 *
 * The default mode is a side-effect-free plan. `--mock` exercises the bounded
 * matrix/report bookkeeping without opening a socket. Only `--live` loads SDKs
 * and sends requests, and live mode requires exact SDK versions, model names,
 * environment-provided credentials, a request cap, an output cap and explicit
 * price inputs. SDK retry defaults are disabled; this runner never retries.
 *
 * This file intentionally does not import openai or @anthropic-ai/sdk. Those
 * packages are not application dependencies and must be installed in a user
 * supplied isolated SDK directory. A live result is therefore impossible to
 * mistake for a verification performed by this repository's dependency set.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const protocols = ['chat', 'responses', 'messages'] as const;
const scenarios = ['json', 'stream', 'tool-json', 'tool-stream'] as const;
type Protocol = (typeof protocols)[number];
type Scenario = (typeof scenarios)[number];
type Mode = 'dry-run' | 'mock' | 'live';
type CaseStatus = 'planned' | 'pass' | 'fail' | 'skipped';

const maxOutputDefault = 128;
const maxOutputCeiling = 512;
const maxRequestsDefault = protocols.length * protocols.length * 6;
const maxRequestsCeiling = maxRequestsDefault;
const timeoutDefault = 30_000;
const safeVersion = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;
const safeModel = /^[^\s\u0000-\u001f\u007f]{1,256}$/u;
const safePackageName = /^[A-Za-z0-9@_./-]+$/u;

interface Models {
  readonly chat?: string;
  readonly responses?: string;
  readonly messages?: string;
}

interface Options {
  readonly mode: Mode;
  readonly sdkDir?: string;
  readonly expectedSdkVersions: Readonly<{ openai?: string; anthropic?: string }>;
  readonly models: Models;
  readonly gatewayUrl?: string;
  readonly platformKey?: string;
  readonly budgetUsd?: number;
  readonly inputPriceUsdPerMillion?: number;
  readonly outputPriceUsdPerMillion?: number;
  readonly maxOutputTokens: number;
  readonly maxRequests: number;
  readonly timeoutMs: number;
}

interface CasePlan {
  readonly id: string;
  readonly downstream: Protocol;
  readonly expectedUpstream: Protocol;
  readonly scenario: Scenario;
  readonly model: string | null;
  readonly maxCalls: number;
  readonly selected: boolean;
}

interface Usage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
}

interface SafeFailure {
  readonly reason: string;
  readonly httpStatus?: number;
  readonly errorCode?: string;
}

interface CaseResult {
  readonly id: string;
  readonly downstream: Protocol;
  readonly expectedUpstream: Protocol;
  readonly scenario: Scenario;
  readonly model: string | null;
  readonly status: CaseStatus;
  readonly transport: 'dry-run' | 'mock' | 'live';
  readonly selected: boolean;
  readonly calls: number;
  readonly maxCalls: number;
  readonly usage?: Usage;
  readonly estimatedCostUsd?: number;
  readonly syntheticUsage?: boolean;
  readonly failure?: SafeFailure;
}

interface SdkStatus {
  readonly package: string;
  readonly requestedVersion: string | null;
  readonly installedVersion: string | null;
  readonly status: 'not_checked' | 'not_required' | 'ready' | 'missing' | 'version_mismatch' | 'invalid';
}

interface Report {
  readonly version: 1;
  readonly checkedAt: string;
  readonly mode: Mode;
  readonly readOnly: true;
  readonly remoteCallsMade: number;
  readonly sdk: { readonly directoryConfigured: boolean; readonly openai: SdkStatus; readonly anthropic: SdkStatus };
  readonly models: Readonly<Record<Protocol, string | null>>;
  readonly limits: { readonly maxRequests: number; readonly maxOutputTokens: number; readonly timeoutMs: number };
  readonly budget: {
    readonly budgetUsd: number | null;
    readonly inputPriceUsdPerMillion: number | null;
    readonly outputPriceUsdPerMillion: number | null;
    readonly estimatedSpentUsd: number | null;
  };
  readonly cases: readonly CaseResult[];
  readonly stopped?: SafeFailure;
  readonly ok: boolean;
}

interface LoadedSdk {
  readonly package: string;
  readonly expectedVersion: string;
  readonly installedVersion: string;
  readonly module: unknown;
}

interface Runtime {
  readonly openai: Record<string, unknown>;
  readonly anthropic: Record<string, unknown>;
}

interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

interface InvocationResult {
  readonly usage?: Usage;
  readonly toolCall?: ToolCall;
  readonly httpStatus?: number;
}

interface MutableBudget {
  requests: number;
  spentUsd: number;
  stopped?: SafeFailure;
}

function usageText(): string {
  return [
    'Q07 real upstream/client matrix verifier (dry-run by default).',
    '',
    'Usage:',
    '  node scripts/verify-upstream-matrix.ts',
    '  node scripts/verify-upstream-matrix.ts --mock [matrix options]',
    '  node scripts/verify-upstream-matrix.ts --live --sdk-dir <isolated-dir> [live options]',
    '',
    'Matrix options:',
    '  --chat-model <id>             Public model used for Chat downstream cases',
    '  --responses-model <id>        Public model used for Responses downstream cases',
    '  --messages-model <id>         Public model used for Messages downstream cases',
    `  --max-output-tokens <n>       Per-call output cap, 1-${maxOutputCeiling} (default ${maxOutputDefault})`,
    `  --max-requests <n>            Hard remote-call cap, 1-${maxRequestsCeiling} (default ${maxRequestsDefault})`,
    '  --timeout-ms <n>              Per-call timeout in milliseconds (default 30000)',
    '',
    'Live-only options:',
    '  --sdk-dir <path>              Isolated directory containing node_modules',
    '  --openai-sdk-version <semver> Exact openai package version to verify',
    '  --anthropic-sdk-version <semver> Exact @anthropic-ai/sdk version to verify',
    '  --budget-usd <n>              Stop after observed estimate reaches this USD budget',
    '  --input-price-usd-per-1m <n>  Price used only for the local estimate',
    '  --output-price-usd-per-1m <n> Price used only for the local estimate',
    '',
    'Environment variables read only in --live:',
    '  Q07_GATEWAY_URL               Gateway origin including /v1',
    '  Q07_PLATFORM_API_KEY          Platform key sent by the SDK; never printed',
    '',
    'The runner sends no request without --live, uses no automatic retries, and never installs packages.',
    'Live mode stops on missing usage, an unknown estimate, a budget overrun, or the request cap.',
  ].join('\n');
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function positiveInteger(value: string, name: string, ceiling: number): number {
  if (!/^\d+$/u.test(value)) throw new Error(`${name} must be a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > ceiling) throw new Error(`${name} must be between 1 and ${ceiling}.`);
  return parsed;
}

function nonnegativeNumber(value: string, name: string): number {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) throw new Error(`${name} must be a finite non-negative decimal.`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a finite non-negative decimal.`);
  return parsed;
}

function modelValue(value: string, name: string): string {
  if (!safeModel.test(value)) throw new Error(`${name} must be 1-256 non-whitespace characters.`);
  return value;
}

function versionValue(value: string, name: string): string {
  if (!safeVersion.test(value)) throw new Error(`${name} must be an exact semantic version.`);
  return value;
}

function takeValue(args: readonly string[], index: number, argument: string, name: string): [string, number] {
  if (argument.startsWith(`${name}=`)) return [argument.slice(name.length + 1), index];
  if (argument === name && index + 1 < args.length && !args[index + 1]!.startsWith('--')) return [args[index + 1]!, index + 1];
  throw new Error(`${name} requires a value.`);
}

function parseArgs(args: readonly string[]): Options {
  let mode: Mode = 'dry-run';
  let sdkDir: string | undefined;
  let openaiVersion: string | undefined;
  let anthropicVersion: string | undefined;
  let chatModel: string | undefined;
  let responsesModel: string | undefined;
  let messagesModel: string | undefined;
  let gatewayUrl: string | undefined;
  let budgetUsd: number | undefined;
  let inputPrice: number | undefined;
  let outputPrice: number | undefined;
  let maxOutputTokens = maxOutputDefault;
  let maxRequests = maxRequestsDefault;
  let timeoutMs = timeoutDefault;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--live') {
      if (mode === 'mock') throw new Error('Choose one of --live or --mock.');
      mode = 'live'; continue;
    }
    if (argument === '--mock') {
      if (mode === 'live') throw new Error('Choose one of --live or --mock.');
      mode = 'mock'; continue;
    }
    if (argument === '--help' || argument === '-h') throw new Error('__HELP__');
    if (argument === '--sdk-dir' || argument.startsWith('--sdk-dir=')) { const [value, next] = takeValue(args, index, argument, '--sdk-dir'); sdkDir = resolve(root, value); index = next; continue; }
    if (argument === '--openai-sdk-version' || argument.startsWith('--openai-sdk-version=')) { const [value, next] = takeValue(args, index, argument, '--openai-sdk-version'); openaiVersion = versionValue(value, '--openai-sdk-version'); index = next; continue; }
    if (argument === '--anthropic-sdk-version' || argument.startsWith('--anthropic-sdk-version=')) { const [value, next] = takeValue(args, index, argument, '--anthropic-sdk-version'); anthropicVersion = versionValue(value, '--anthropic-sdk-version'); index = next; continue; }
    if (argument === '--chat-model' || argument.startsWith('--chat-model=')) { const [value, next] = takeValue(args, index, argument, '--chat-model'); chatModel = modelValue(value, '--chat-model'); index = next; continue; }
    if (argument === '--responses-model' || argument.startsWith('--responses-model=')) { const [value, next] = takeValue(args, index, argument, '--responses-model'); responsesModel = modelValue(value, '--responses-model'); index = next; continue; }
    if (argument === '--messages-model' || argument.startsWith('--messages-model=')) { const [value, next] = takeValue(args, index, argument, '--messages-model'); messagesModel = modelValue(value, '--messages-model'); index = next; continue; }
    if (argument === '--gateway-url' || argument.startsWith('--gateway-url=')) { const [value, next] = takeValue(args, index, argument, '--gateway-url'); gatewayUrl = value; index = next; continue; }
    if (argument === '--budget-usd' || argument.startsWith('--budget-usd=')) { const [value, next] = takeValue(args, index, argument, '--budget-usd'); budgetUsd = nonnegativeNumber(value, '--budget-usd'); index = next; continue; }
    if (argument === '--input-price-usd-per-1m' || argument.startsWith('--input-price-usd-per-1m=')) { const [value, next] = takeValue(args, index, argument, '--input-price-usd-per-1m'); inputPrice = nonnegativeNumber(value, '--input-price-usd-per-1m'); index = next; continue; }
    if (argument === '--output-price-usd-per-1m' || argument.startsWith('--output-price-usd-per-1m=')) { const [value, next] = takeValue(args, index, argument, '--output-price-usd-per-1m'); outputPrice = nonnegativeNumber(value, '--output-price-usd-per-1m'); index = next; continue; }
    if (argument === '--max-output-tokens' || argument.startsWith('--max-output-tokens=')) { const [value, next] = takeValue(args, index, argument, '--max-output-tokens'); maxOutputTokens = positiveInteger(value, '--max-output-tokens', maxOutputCeiling); index = next; continue; }
    if (argument === '--max-requests' || argument.startsWith('--max-requests=')) { const [value, next] = takeValue(args, index, argument, '--max-requests'); maxRequests = positiveInteger(value, '--max-requests', maxRequestsCeiling); index = next; continue; }
    if (argument === '--timeout-ms' || argument.startsWith('--timeout-ms=')) { const [value, next] = takeValue(args, index, argument, '--timeout-ms'); timeoutMs = positiveInteger(value, '--timeout-ms', 120_000); index = next; continue; }
    throw new Error(`Unknown option: ${argument}`);
  }

  if (mode === 'live') {
    if (!sdkDir || !openaiVersion || !anthropicVersion) throw new Error('--live requires --sdk-dir, --openai-sdk-version and --anthropic-sdk-version.');
    if (!chatModel || !responsesModel || !messagesModel) throw new Error('--live requires --chat-model, --responses-model and --messages-model.');
    if (budgetUsd === undefined || inputPrice === undefined || outputPrice === undefined) throw new Error('--live requires --budget-usd and both local price inputs.');
    gatewayUrl ??= process.env.Q07_GATEWAY_URL;
    if (!gatewayUrl) throw new Error('--live requires Q07_GATEWAY_URL or --gateway-url.');
    if (!process.env.Q07_PLATFORM_API_KEY) throw new Error('--live requires Q07_PLATFORM_API_KEY.');
    validateLiveGateway(gatewayUrl);
  }

  return {
    mode,
    ...(sdkDir === undefined ? {} : { sdkDir }),
    expectedSdkVersions: { ...(openaiVersion === undefined ? {} : { openai: openaiVersion }), ...(anthropicVersion === undefined ? {} : { anthropic: anthropicVersion }) },
    models: { ...(chatModel === undefined ? {} : { chat: chatModel }), ...(responsesModel === undefined ? {} : { responses: responsesModel }), ...(messagesModel === undefined ? {} : { messages: messagesModel }) },
    ...(gatewayUrl === undefined ? {} : { gatewayUrl }),
    /* Credentials are read only in live mode; dry-run/mock reports never
     * inspect the environment, even if a shell happens to export a key. */
    ...(mode === 'live' && process.env.Q07_PLATFORM_API_KEY !== undefined ? { platformKey: process.env.Q07_PLATFORM_API_KEY } : {}),
    ...(budgetUsd === undefined ? {} : { budgetUsd }),
    ...(inputPrice === undefined ? {} : { inputPriceUsdPerMillion: inputPrice }),
    ...(outputPrice === undefined ? {} : { outputPriceUsdPerMillion: outputPrice }),
    maxOutputTokens, maxRequests, timeoutMs,
  };
}

function validateLiveGateway(value: string): void {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error('Q07_GATEWAY_URL must be an absolute URL.'); }
  if (!['https:', 'http:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.hash) throw new Error('Q07_GATEWAY_URL must use a credential-free HTTP(S) URL.');
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
  if (parsed.protocol !== 'https:' && !local) throw new Error('Live gateway URLs must use HTTPS unless they target localhost.');
  if (!parsed.pathname.replace(/\/+$/u, '').endsWith('/v1')) throw new Error('Q07_GATEWAY_URL must include the /v1 API path.');
}

function makePlans(options: Options): readonly CasePlan[] {
  const plans: CasePlan[] = [];
  let calls = 0;
  for (const downstream of protocols) for (const expectedUpstream of protocols) for (const scenario of scenarios) {
    const maxCalls = scenario.startsWith('tool-') ? 2 : 1;
    const selected = calls + maxCalls <= options.maxRequests;
    if (selected) calls += maxCalls;
    plans.push({ id: `${downstream}-${expectedUpstream}-${scenario}`, downstream, expectedUpstream, scenario,
      model: options.models[downstream] ?? null, maxCalls, selected });
  }
  return plans;
}

function sdkStatus(packageName: string, requestedVersion: string | undefined, status: SdkStatus['status'], installedVersion?: string): SdkStatus {
  return { package: packageName, requestedVersion: requestedVersion ?? null, installedVersion: installedVersion ?? null, status };
}

function drySdk(options: Options): { readonly openai: SdkStatus; readonly anthropic: SdkStatus } {
  return {
    openai: sdkStatus('openai', options.expectedSdkVersions.openai, 'not_checked'),
    anthropic: sdkStatus('@anthropic-ai/sdk', options.expectedSdkVersions.anthropic, 'not_checked'),
  };
}

function mockSdk(): { readonly openai: SdkStatus; readonly anthropic: SdkStatus } {
  return { openai: sdkStatus('openai', undefined, 'not_required'), anthropic: sdkStatus('@anthropic-ai/sdk', undefined, 'not_required') };
}

function models(options: Options): Readonly<Record<Protocol, string | null>> {
  return { chat: options.models.chat ?? null, responses: options.models.responses ?? null, messages: options.models.messages ?? null };
}

function limits(options: Options): Report['limits'] {
  return { maxRequests: options.maxRequests, maxOutputTokens: options.maxOutputTokens, timeoutMs: options.timeoutMs };
}

function budget(options: Options, spent: number | null): Report['budget'] {
  return { budgetUsd: options.budgetUsd ?? null, inputPriceUsdPerMillion: options.inputPriceUsdPerMillion ?? null,
    outputPriceUsdPerMillion: options.outputPriceUsdPerMillion ?? null, estimatedSpentUsd: spent };
}

function planReport(options: Options): Report {
  const cases = makePlans(options).map(plan => ({ id: plan.id, downstream: plan.downstream, expectedUpstream: plan.expectedUpstream,
    scenario: plan.scenario, model: plan.model, status: 'planned' as const, transport: 'dry-run' as const, selected: plan.selected,
    calls: 0, maxCalls: plan.maxCalls }));
  return { version: 1, checkedAt: new Date().toISOString(), mode: 'dry-run', readOnly: true, remoteCallsMade: 0,
    sdk: { directoryConfigured: options.sdkDir !== undefined, ...drySdk(options) }, models: models(options), limits: limits(options), budget: budget(options, null), cases,
    ok: true };
}

function mockReport(options: Options): Report {
  const cases: CaseResult[] = [];
  let calls = 0;
  for (const plan of makePlans(options)) {
    if (!plan.selected) { cases.push({ ...plan, status: 'skipped', transport: 'mock', selected: false, calls: 0, failure: { reason: 'max_requests' } }); continue; }
    calls += plan.maxCalls;
    cases.push({ ...plan, status: 'pass', transport: 'mock', selected: true, calls: plan.maxCalls,
      usage: { inputTokens: 8 * plan.maxCalls, outputTokens: 4 * plan.maxCalls, totalTokens: 12 * plan.maxCalls }, syntheticUsage: true, estimatedCostUsd: 0 });
  }
  return { version: 1, checkedAt: new Date().toISOString(), mode: 'mock', readOnly: true, remoteCallsMade: 0,
    sdk: { directoryConfigured: options.sdkDir !== undefined, ...mockSdk() }, models: models(options), limits: limits(options), budget: budget(options, 0), cases, ok: true };
}

function packageJsonPath(sdkDir: string, packageName: string): string | undefined {
  if (!safePackageName.test(packageName)) return undefined;
  const direct = resolve(sdkDir, 'package.json');
  try { const value = JSON.parse(readFileSync(direct, 'utf8')) as unknown; if (record(value)?.name === packageName) return direct; } catch { /* package directory is checked below */ }
  const candidate = resolve(sdkDir, 'node_modules', ...packageName.split('/'), 'package.json');
  return existsSync(candidate) ? candidate : undefined;
}

function loadSdk(sdkDir: string, packageName: string, expectedVersion: string): LoadedSdk | SafeFailure {
  const packagePath = packageJsonPath(sdkDir, packageName);
  if (!packagePath) return { reason: `${packageName}_missing` };
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(packagePath, 'utf8')); } catch { return { reason: `${packageName}_package_invalid` }; }
  const installed = stringValue(record(parsed)?.version);
  if (!installed) return { reason: `${packageName}_version_missing` };
  if (installed !== expectedVersion) return { reason: `${packageName}_version_mismatch`, errorCode: installed };
  try {
    const require = createRequire(packagePath);
    return { package: packageName, expectedVersion, installedVersion: installed, module: require(packageName) };
  } catch { return { reason: `${packageName}_load_failed` }; }
}

function constructorFrom(module: unknown): (new (options: Record<string, unknown>) => unknown) | undefined {
  if (typeof module === 'function') return module as new (options: Record<string, unknown>) => unknown;
  const value = record(module)?.default;
  return typeof value === 'function' ? value as new (options: Record<string, unknown>) => unknown : undefined;
}

function loadRuntime(options: Options): { readonly runtime?: Runtime; readonly sdk: Report['sdk']; readonly failure?: SafeFailure } {
  const directory = options.sdkDir;
  const expectedOpenai = options.expectedSdkVersions.openai;
  const expectedAnthropic = options.expectedSdkVersions.anthropic;
  if (!directory || !expectedOpenai || !expectedAnthropic) return { sdk: { directoryConfigured: false, openai: sdkStatus('openai', expectedOpenai, 'invalid'), anthropic: sdkStatus('@anthropic-ai/sdk', expectedAnthropic, 'invalid') }, failure: { reason: 'live_sdk_configuration_missing' } };
  const openai = loadSdk(directory, 'openai', expectedOpenai);
  const anthropic = loadSdk(directory, '@anthropic-ai/sdk', expectedAnthropic);
  const openaiReady = 'module' in openai;
  const anthropicReady = 'module' in anthropic;
  const openaiStatus = openaiReady ? sdkStatus('openai', expectedOpenai, 'ready', openai.installedVersion) : sdkStatus('openai', expectedOpenai, openai.reason.endsWith('_version_mismatch') ? 'version_mismatch' : 'missing', openai.errorCode);
  const anthropicStatus = anthropicReady ? sdkStatus('@anthropic-ai/sdk', expectedAnthropic, 'ready', anthropic.installedVersion) : sdkStatus('@anthropic-ai/sdk', expectedAnthropic, anthropic.reason.endsWith('_version_mismatch') ? 'version_mismatch' : 'missing', anthropic.errorCode);
  if (!openaiReady || !anthropicReady) return { sdk: { directoryConfigured: true, openai: openaiStatus, anthropic: anthropicStatus }, failure: { reason: 'sdk_preflight_failed' } };
  const openaiConstructor = constructorFrom(openai.module);
  const anthropicConstructor = constructorFrom(anthropic.module);
  if (!openaiConstructor || !anthropicConstructor) return { sdk: { directoryConfigured: true, openai: { ...openaiStatus, status: 'invalid' }, anthropic: { ...anthropicStatus, status: 'invalid' } }, failure: { reason: 'sdk_constructor_missing' } };
  try {
    const clientOptions = { apiKey: options.platformKey!, baseURL: options.gatewayUrl!, timeout: options.timeoutMs, maxRetries: 0 };
    return { runtime: { openai: record(new openaiConstructor(clientOptions)) ?? {}, anthropic: record(new anthropicConstructor(clientOptions)) ?? {} }, sdk: { directoryConfigured: true, openai: openaiStatus, anthropic: anthropicStatus } };
  } catch { return { sdk: { directoryConfigured: true, openai: openaiStatus, anthropic: anthropicStatus }, failure: { reason: 'sdk_client_initialization_failed' } }; }
}

function requestBody(protocol: Protocol, model: string, stream: boolean, maxOutputTokens: number): Record<string, unknown> {
  if (protocol === 'chat') return { model, messages: [{ role: 'user', content: 'Q07 text probe' }], max_tokens: maxOutputTokens,
    ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}) };
  if (protocol === 'responses') return { model, input: 'Q07 text probe', max_output_tokens: maxOutputTokens, ...(stream ? { stream: true } : {}) };
  return { model, max_tokens: maxOutputTokens, messages: [{ role: 'user', content: 'Q07 text probe' }], ...(stream ? { stream: true } : {}) };
}

function toolBody(protocol: Protocol, model: string, stream: boolean, maxOutputTokens: number): Record<string, unknown> {
  const tool = { name: 'q07_lookup', description: 'Returns a fixed synthetic value.', input_schema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false }, strict: false };
  if (protocol === 'chat') return { model, messages: [{ role: 'user', content: 'Call q07_lookup.' }], max_tokens: maxOutputTokens, tools: [{ type: 'function', function: tool }], tool_choice: { type: 'function', function: { name: tool.name } }, ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}) };
  if (protocol === 'responses') return { model, input: 'Call q07_lookup.', max_output_tokens: maxOutputTokens, tools: [{ type: 'function', name: tool.name, description: tool.description, parameters: tool.input_schema, strict: false }], tool_choice: { type: 'function', name: tool.name }, ...(stream ? { stream: true } : {}) };
  return { model, max_tokens: maxOutputTokens, messages: [{ role: 'user', content: 'Call q07_lookup.' }], tools: [{ type: 'custom', ...tool }], tool_choice: { type: 'tool', name: tool.name }, ...(stream ? { stream: true } : {}) };
}

function followupBody(protocol: Protocol, model: string, stream: boolean, maxOutputTokens: number, call: ToolCall): Record<string, unknown> {
  if (protocol === 'chat') return { model, messages: [{ role: 'user', content: 'Call q07_lookup.' }, { role: 'assistant', content: null,
    tool_calls: [{ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } }] }, { role: 'tool', tool_call_id: call.id, content: 'q07-result' }], max_tokens: maxOutputTokens,
    ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}) };
  if (protocol === 'responses') return { model, input: [{ role: 'user', content: 'Call q07_lookup.' }, { type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments }, { type: 'function_call_output', call_id: call.id, output: 'q07-result' }], max_output_tokens: maxOutputTokens, ...(stream ? { stream: true } : {}) };
  return { model, max_tokens: maxOutputTokens, messages: [{ role: 'user', content: 'Call q07_lookup.' }, { role: 'assistant', content: [{ type: 'tool_use', id: call.id, name: call.name, input: parseArguments(call.arguments) }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: 'q07-result' }] }], ...(stream ? { stream: true } : {}) };
}

function parseArguments(value: string): Record<string, unknown> {
  try { const parsed = JSON.parse(value) as unknown; return record(parsed) ?? {}; } catch { return {}; }
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : typeof value === 'string' && /^\d+$/u.test(value) && Number(value) <= Number.MAX_SAFE_INTEGER ? Number(value) : undefined;
}

function usageFrom(value: unknown): Usage | undefined {
  const source = record(value);
  if (!source) return undefined;
  /* Responses and Messages stream events carry usage inside their terminal
   * response/message envelope, while Chat chunks put it at the top level. */
  const nested = record(source.response) ?? record(source.message);
  const usage = record(source.usage) ?? record(nested?.usage) ?? source;
  const inputTokens = count(usage.input_tokens) ?? count(usage.prompt_tokens);
  const outputTokens = count(usage.output_tokens) ?? count(usage.completion_tokens);
  const totalTokens = count(usage.total_tokens) ?? (inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined);
  return inputTokens === undefined && outputTokens === undefined && totalTokens === undefined ? undefined : { ...(inputTokens === undefined ? {} : { inputTokens }), ...(outputTokens === undefined ? {} : { outputTokens }), ...(totalTokens === undefined ? {} : { totalTokens }) };
}

function mergeUsage(left: Usage | undefined, right: Usage | undefined): Usage | undefined {
  if (!left) return right;
  if (!right) return left;
  const inputTokens = left.inputTokens === undefined || right.inputTokens === undefined ? undefined : left.inputTokens + right.inputTokens;
  const outputTokens = left.outputTokens === undefined || right.outputTokens === undefined ? undefined : left.outputTokens + right.outputTokens;
  const totalTokens = left.totalTokens === undefined || right.totalTokens === undefined ? undefined : left.totalTokens + right.totalTokens;
  return { ...(inputTokens === undefined ? {} : { inputTokens }), ...(outputTokens === undefined ? {} : { outputTokens }), ...(totalTokens === undefined ? {} : { totalTokens }) };
}

/** Stream events expose cumulative usage at different lifecycle points. Keep
 * the newest known fields within one call; `mergeUsage` is reserved for
 * adding usage from two separate tool-round-trip requests. */
function latestUsage(left: Usage | undefined, right: Usage | undefined): Usage | undefined {
  if (!left) return right;
  if (!right) return left;
  return { ...(right.inputTokens === undefined ? left.inputTokens === undefined ? {} : { inputTokens: left.inputTokens } : { inputTokens: right.inputTokens }),
    ...(right.outputTokens === undefined ? left.outputTokens === undefined ? {} : { outputTokens: left.outputTokens } : { outputTokens: right.outputTokens }),
    ...(right.totalTokens === undefined ? left.totalTokens === undefined ? {} : { totalTokens: left.totalTokens } : { totalTokens: right.totalTokens }) };
}

function toolFrom(value: unknown, protocol: Protocol): ToolCall | undefined {
  const source = record(value);
  if (!source) return undefined;
  if (protocol === 'chat') {
    const choices = Array.isArray(source.choices) ? source.choices : [];
    const message = record(record(choices[0])?.message);
    const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
    const call = record(calls[0]); const fn = record(call?.function);
    if (stringValue(call?.id) && stringValue(fn?.name)) return { id: call!.id as string, name: fn!.name as string, arguments: stringValue(fn?.arguments) ?? '{}' };
  } else if (protocol === 'responses') {
    const output = Array.isArray(source.output) ? source.output : [];
    const call = output.map(record).find(item => item?.type === 'function_call');
    if (stringValue(call?.call_id) && stringValue(call?.name)) return { id: call!.call_id as string, name: call!.name as string, arguments: stringValue(call!.arguments) ?? '{}' };
  } else {
    const content = Array.isArray(source.content) ? source.content : [];
    const call = content.map(record).find(item => item?.type === 'tool_use');
    if (stringValue(call?.id) && stringValue(call?.name)) return { id: call!.id as string, name: call!.name as string, arguments: JSON.stringify(record(call!.input) ?? {}) };
  }
  return undefined;
}

function streamToolFrom(value: unknown, protocol: Protocol, partial: Map<string, { name: string; arguments: string }>): void {
  const source = record(value);
  if (!source) return;
  const usage = usageFrom(source);
  void usage;
  if (protocol === 'chat') {
    const choices = Array.isArray(source.choices) ? source.choices : [];
    const deltas = Array.isArray(record(choices[0])?.delta && record(record(choices[0])?.delta)?.tool_calls) ? record(record(choices[0])?.delta)?.tool_calls as unknown[] : [];
    for (const item of deltas) { const call = record(item); const fn = record(call?.function); const id = stringValue(call?.id) ?? `index_${String(call?.index ?? 0)}`; const previous = partial.get(id); partial.set(id, { name: stringValue(fn?.name) ?? previous?.name ?? '', arguments: `${previous?.arguments ?? ''}${stringValue(fn?.arguments) ?? ''}` }); }
  } else if (protocol === 'responses') {
    const item = record(source.item);
    if (item?.type === 'function_call' && stringValue(item.call_id) && stringValue(item.name)) partial.set(item.call_id as string, { name: item.name as string, arguments: stringValue(item.arguments) ?? '{}' });
    if (source.type === 'response.function_call_arguments.done' && stringValue(source.item_id)) { const previous = partial.get(source.item_id as string); if (previous) partial.set(source.item_id as string, { ...previous, arguments: stringValue(source.arguments) ?? previous.arguments }); }
  } else {
    const block = record(source.content_block);
    if (source.type === 'content_block_start' && block?.type === 'tool_use' && stringValue(block.id) && stringValue(block.name)) {
      const input = record(block.input);
      partial.set(block.id as string, { name: block.name as string, arguments: input && Object.keys(input).length > 0 ? JSON.stringify(input) : '' });
    }
    if (source.type === 'content_block_delta' && record(source.delta)?.type === 'input_json_delta') {
      const index = String(source.index ?? '0'); const previous = partial.get(index); if (previous) partial.set(index, { ...previous, arguments: `${previous.arguments}${stringValue(record(source.delta)?.partial_json) ?? ''}` });
    }
  }
}

function streamTool(partial: Map<string, { name: string; arguments: string }>): ToolCall | undefined {
  const first = partial.entries().next().value as [string, { name: string; arguments: string }] | undefined;
  return first && first[1].name ? { id: first[0], name: first[1].name, arguments: first[1].arguments || '{}' } : undefined;
}

function safeFailure(error: unknown): SafeFailure {
  const source = record(error);
  const status = count(source?.status);
  const code = stringValue(source?.code);
  return { reason: 'sdk_request_failed', ...(status === undefined ? {} : { httpStatus: status }), ...(code && /^[A-Za-z0-9_.-]{1,64}$/u.test(code) ? { errorCode: code } : {}) };
}

async function invoke(client: Record<string, unknown>, protocol: Protocol, body: Record<string, unknown>, stream: boolean, options: Options): Promise<InvocationResult> {
  const service = protocol === 'messages' ? record(client.messages) : protocol === 'responses' ? record(client.responses) : record(client.chat);
  const createOwner = protocol === 'messages' ? service : protocol === 'responses' ? service : record(service?.completions);
  const create = createOwner?.create;
  if (typeof create !== 'function') throw new Error('sdk_method_missing');
  const result = await (create as (body: Record<string, unknown>) => Promise<unknown>).call(createOwner, body);
  if (!stream) return { usage: usageFrom(result), toolCall: toolFrom(result, protocol), httpStatus: 200 };
  const partial = new Map<string, { name: string; arguments: string }>();
  let usage: Usage | undefined;
  if (result && typeof (result as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function') {
    for await (const event of result as AsyncIterable<unknown>) { usage = latestUsage(usage, usageFrom(event)); streamToolFrom(event, protocol, partial); }
  }
  const finalMessage = record(result)?.finalMessage;
  if (typeof finalMessage === 'function') { const final = await (finalMessage as () => Promise<unknown>).call(result); usage = latestUsage(usage, usageFrom(final)); const finalTool = toolFrom(final, protocol); if (finalTool) return { usage, toolCall: finalTool, httpStatus: 200 }; }
  return { usage, toolCall: streamTool(partial), httpStatus: 200 };
}

function estimate(usage: Usage | undefined, options: Options): number | undefined {
  if (!usage || usage.inputTokens === undefined || usage.outputTokens === undefined || options.inputPriceUsdPerMillion === undefined || options.outputPriceUsdPerMillion === undefined) return undefined;
  return (usage.inputTokens * options.inputPriceUsdPerMillion + usage.outputTokens * options.outputPriceUsdPerMillion) / 1_000_000;
}

function completeUsage(first: Usage | undefined, second: Usage | undefined): Usage | undefined {
  const combined = mergeUsage(first, second);
  return combined?.inputTokens !== undefined && combined.outputTokens !== undefined ? combined : undefined;
}

async function executeCase(plan: CasePlan, options: Options, runtime: Runtime, state: MutableBudget): Promise<CaseResult> {
  if (!plan.selected || state.stopped) return { ...plan, status: 'skipped', transport: 'live', selected: false, calls: 0, failure: state.stopped ?? { reason: 'max_requests' } };
  if (!plan.model) return { ...plan, status: 'fail', transport: 'live', selected: true, calls: 0, failure: { reason: 'model_missing' } };
  const stream = plan.scenario.endsWith('stream');
  const tool = plan.scenario.startsWith('tool-');
  let calls = 0;
  let usage: Usage | undefined;
  try {
    const invokeOne = async (body: Record<string, unknown>): Promise<InvocationResult> => {
      if (state.requests >= options.maxRequests) { state.stopped = { reason: 'max_requests' }; throw new Error('max_requests'); }
      state.requests += 1; calls += 1;
      const client = plan.downstream === 'messages' ? runtime.anthropic : runtime.openai;
      return await invoke(client, plan.downstream, body, stream, options);
    };
    const first = await invokeOne(tool ? toolBody(plan.downstream, plan.model, stream, options.maxOutputTokens) : requestBody(plan.downstream, plan.model, stream, options.maxOutputTokens));
    usage = mergeUsage(usage, first.usage);
    if (tool) {
      if (!first.toolCall) return { ...plan, status: 'fail', transport: 'live', selected: true, calls, usage: completeUsage(usage, undefined), failure: { reason: 'tool_call_missing' } };
      const second = await invokeOne(followupBody(plan.downstream, plan.model, stream, options.maxOutputTokens, first.toolCall));
      usage = mergeUsage(usage, second.usage);
    }
    const verified = completeUsage(usage, undefined);
    if (!verified) { state.stopped = { reason: 'unknown_usage' }; return { ...plan, status: 'fail', transport: 'live', selected: true, calls, failure: state.stopped }; }
    const cost = estimate(verified, options);
    if (cost === undefined) { state.stopped = { reason: 'unknown_cost_estimate' }; return { ...plan, status: 'fail', transport: 'live', selected: true, calls, usage: verified, failure: state.stopped }; }
    state.spentUsd += cost;
    if (state.spentUsd > options.budgetUsd!) { state.stopped = { reason: 'budget_exceeded' }; return { ...plan, status: 'fail', transport: 'live', selected: true, calls, usage: verified, estimatedCostUsd: cost, failure: state.stopped }; }
    return { ...plan, status: 'pass', transport: 'live', selected: true, calls, usage: verified, estimatedCostUsd: cost };
  } catch (error) {
    if (state.stopped) return { ...plan, status: 'skipped', transport: 'live', selected: false, calls, failure: state.stopped };
    return { ...plan, status: 'fail', transport: 'live', selected: true, calls, ...(usage === undefined ? {} : { usage }), failure: safeFailure(error) };
  }
}

async function liveReport(options: Options): Promise<Report> {
  const loaded = loadRuntime(options);
  if (!loaded.runtime || loaded.failure) {
    const cases = makePlans(options).map(plan => ({ ...plan, status: 'skipped' as const, transport: 'live' as const, selected: false, calls: 0, failure: loaded.failure ?? { reason: 'sdk_preflight_failed' } }));
    return { version: 1, checkedAt: new Date().toISOString(), mode: 'live', readOnly: true, remoteCallsMade: 0, sdk: loaded.sdk, models: models(options), limits: limits(options), budget: budget(options, null), cases, stopped: loaded.failure, ok: false };
  }
  const state: MutableBudget = { requests: 0, spentUsd: 0 };
  const cases: CaseResult[] = [];
  for (const plan of makePlans(options)) {
    const result = await executeCase(plan, options, loaded.runtime, state); cases.push(result);
    if (state.stopped) break;
  }
  if (state.stopped) for (const plan of makePlans(options).slice(cases.length)) cases.push({ ...plan, status: 'skipped', transport: 'live', selected: false, calls: 0, failure: state.stopped });
  return { version: 1, checkedAt: new Date().toISOString(), mode: 'live', readOnly: true, remoteCallsMade: state.requests, sdk: loaded.sdk, models: models(options), limits: limits(options), budget: budget(options, state.spentUsd), cases, ...(state.stopped ? { stopped: state.stopped } : {}), ok: cases.length > 0 && cases.every(item => item.status === 'pass') };
}

async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) { process.stdout.write(`${usageText()}\n`); return; }
  let options: Options;
  try { options = parseArgs(args); } catch (error) {
    if (error instanceof Error && error.message === '__HELP__') { process.stdout.write(`${usageText()}\n`); return; }
    process.stderr.write(`${error instanceof Error ? error.message : 'Invalid arguments'}\n${usageText()}\n`); process.exitCode = 2; return;
  }
  const report = options.mode === 'dry-run' ? planReport(options) : options.mode === 'mock' ? mockReport(options) : await liveReport(options);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => { process.stderr.write('Q07 verifier failed.\n'); process.exitCode = 2; });
