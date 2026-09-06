/**
 * OMA - Open Multi Agent harness.
 *
 * Public API re-exports.
 */

export { OMA } from './agent.js';
export { CoreLoop, Status, TaskState, DEFAULT_LOOP_CONFIG } from './core/loop.js';
export type { LoopConfig, TaskStateData, SolveFn, SanitizeFn, HandoffFn } from './core/loop.js';
export { CriteriaSet, Criterion, CriterionType, ensureCriteria } from './core/criteria.js';
export type { CriterionInit, CriterionScore } from './core/criteria.js';
export { Sanitizer, sanitize } from './core/sanitize.js';
export { HandoffNote, nearOutageHandler, outageRecoveryPrompt } from './core/edge.js';
export { ProviderRegistry, ProviderHealth } from './providers/registry.js';
export { AuthManager, CredentialStore, AuthStatus, PROVIDER_AUTH } from './providers/auth.js';
export type { Credential } from './providers/auth.js';
export { Provider, RateLimiter, ErrorClass } from './providers/base.js';
export type { ProviderResponse, Message } from './providers/base.js';
export { HTTPProvider, PROVIDER_CONFIGS } from './providers/http-providers.js';
export type { ProviderConfig } from './providers/http-providers.js';
export {
  ClaudeSubscriptionProvider,
  ChatGPTSubscriptionProvider,
  GeminiSubscriptionProvider,
  makeSubscriptionProvider,
} from './providers/subscription.js';
export { WorkingMemory, PersistentMemory, ContextOptimizer } from './automation/memory.js';
export type { MemoryEntry } from './automation/memory.js';
export { PageAutomator, ScrollStrategy, DEFAULT_PAGE_CONFIG } from './automation/page.js';
export type { PageConfig, PageState } from './automation/page.js';
export { PixelAutomator } from './automation/pixel.js';
export type { ScreenRegion, ClickTarget, TypeAction } from './automation/pixel.js';
