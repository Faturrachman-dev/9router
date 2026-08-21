"use client";

import { useRef, useState, useMemo } from "react";
import PropTypes from "prop-types";

// Strip composite provider IDs for icon lookup: openai-compatible-chat-clinepass → clinepass
// UUID-based custom providers → generic "openai" (or "anthropic" if prefixed)
const KIND_PREFIXES = [
  "openai-compatible-chat-", "openai-compatible-responses-",
  "anthropic-compatible-chat-", "anthropic-compatible-responses-",
  "ai-", "llm-",
];
const STANDALONE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ICON_ALIASES = { opencode: "opencode", clinepass: "cline", agentrouter: "openai", commandcode: "commandcode", copilot: "copilot" };

/**
 * Strip composite provider IDs for icon filename lookup.
 * openai-compatible-chat-clinepass → clinepass (then alias → cline.png)
 * openai-compatible-chat-UUID → openai.png (generic fallback)
 */
export function resolveProviderIconSrc(providerId) {
  if (!providerId) return null;
  let id = providerId;
  for (const p of KIND_PREFIXES) {
    if (id.toLowerCase().startsWith(p)) { id = id.slice(p.length); break; }
  }
  if (STANDALONE_UUID_RE.test(id)) {
    return `/providers/${providerId.startsWith("anthropic") ? "anthropic" : "openai"}.png`;
  }
  const alias = ICON_ALIASES[id.toLowerCase()];
  if (alias) return `/providers/${alias}.png`;
  return `/providers/${id}.png`;
}

export default function ProviderIcon({
  src,
  provider,
  alt,
  size = 32,
  className = "",
  fallbackText = "?",
  fallbackColor,
}) {
  const [errored, setErrored] = useState(false);
  const done = useRef(false);

  const resolvedSrc = useMemo(() => {
    if (src) return src;
    if (provider) return resolveProviderIconSrc(provider);
    return null;
  }, [src, provider]);

  const handleError = (e) => {
    if (done.current) return;
    done.current = true;
    e.currentTarget.onerror = null;
    setErrored(true);
  };

  if (!resolvedSrc || errored) {
    return (
      <span
        className={`inline-flex items-center justify-center font-bold rounded-lg ${className}`.trim()}
        style={{
          width: size,
          height: size,
          color: fallbackColor,
          fontSize: Math.max(10, Math.floor(size * 0.38)),
        }}
      >
        {fallbackText}
      </span>
    );
  }

  return (
    <img
      src={resolvedSrc}
      alt={alt}
      width={size}
      height={size}
      className={className}
      onError={handleError}
    />
  );
}

ProviderIcon.propTypes = {
  src: PropTypes.string,
  provider: PropTypes.string,
  alt: PropTypes.string,
  size: PropTypes.number,
  className: PropTypes.string,
  fallbackText: PropTypes.string,
  fallbackColor: PropTypes.string,
};
