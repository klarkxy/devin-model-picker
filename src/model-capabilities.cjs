'use strict';

// /models commonly reports IDs only. Keep provider-specific overrides explicit;
// use the standard GPT/o reasoning controls only for recognizable base IDs.
function modelEfforts(model) {
  if (Array.isArray(model.efforts) && model.efforts.length) return [...new Set(model.efforts)];
  const id = String(model.id || '').split('/').at(-1);
  if (/^(?:gpt-[56](?:[.-]|$)|o[134](?:-|$))/i.test(id) &&
      !/(?:^|-)(?:none|minimal|low|medium|high|xhigh|max|ultra)(?:-|$)/i.test(id)) {
    // The null variant retains previously saved UIDs and provider-default behavior.
    return [null, 'low', 'medium', 'high', 'xhigh', 'max'];
  }
  // Claude Opus/Sonnet/Fable 4.6+ accept output_config.effort; Haiku does not.
  if (/^claude-(?:opus|sonnet|fable|mythos)-(?:[5-9]|4-[6-9])(?:[-.]|$)/i.test(id)) return [null, 'low', 'medium', 'high', 'xhigh', 'max'];
  return [null];
}

// Imported metadata records supportsImages; default to advertising it when the
// source knew nothing rather than silently dropping vision inputs.
function modelSupportsImages(model) {
  return model.supportsImages !== false;
}

module.exports = { modelEfforts, modelSupportsImages };
