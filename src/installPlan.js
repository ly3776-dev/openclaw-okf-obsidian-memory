export const INSTALL_MODES = Object.freeze({
  AUTO: "AUTO",
  REUSE_EXISTING: "REUSE_EXISTING",
  SIDECAR: "SIDECAR",
  ISOLATED: "ISOLATED"
});

export function normalizeInstallMode(value = "AUTO") {
  const normalized = String(value || "AUTO").trim().replaceAll("-", "_").toUpperCase();
  if (!Object.hasOwn(INSTALL_MODES, normalized)) {
    throw new Error(`Unsupported install mode: ${value}. Expected AUTO, REUSE_EXISTING, SIDECAR, or ISOLATED.`);
  }
  return INSTALL_MODES[normalized];
}

export function resolveInstallPlan({
  requestedMode = "AUTO",
  configExists = false,
  memorySearch = {},
  memoryStatuses = [],
  embeddingProbeOk = false,
  gatewayStatus = {},
  allowProviderReplace = false
} = {}) {
  const requested = normalizeInstallMode(requestedMode);
  const provider = String(memorySearch?.provider || "").trim();
  const model = String(memorySearch?.model || "").trim();
  const semanticConfigured = Boolean(provider && provider !== "none");
  const statuses = Array.isArray(memoryStatuses) ? memoryStatuses : [];
  const vectorEnabled = statuses.some((entry) => entry?.status?.vector?.enabled === true);
  const vectorReady = semanticConfigured && vectorEnabled && embeddingProbeOk;
  const gatewayLoaded = gatewayStatus?.service?.loaded === true;
  const gatewayRunning = String(gatewayStatus?.service?.runtime?.status || "").toLowerCase() === "running"
    || String(gatewayStatus?.service?.runtime?.state || "").toLowerCase() === "running";

  let resolved = requested;
  let reason = "explicit_mode";
  if (requested === INSTALL_MODES.AUTO) {
    if (vectorReady) {
      resolved = INSTALL_MODES.REUSE_EXISTING;
      reason = "existing_openclaw_vector_ready";
    } else if (semanticConfigured) {
      resolved = INSTALL_MODES.SIDECAR;
      reason = "existing_vector_config_not_healthy_preserved";
    } else {
      resolved = INSTALL_MODES.ISOLATED;
      reason = configExists ? "existing_openclaw_has_no_vector_provider" : "new_openclaw_install";
    }
  }

  if (resolved === INSTALL_MODES.REUSE_EXISTING && !vectorReady) {
    throw new Error("REUSE_EXISTING requires a configured OpenClaw provider, an enabled vector index, and a successful read-only memory search probe.");
  }
  if (resolved === INSTALL_MODES.ISOLATED && semanticConfigured && !allowProviderReplace) {
    throw new Error("ISOLATED would replace an existing OpenClaw memory provider. Use SIDECAR, repair REUSE_EXISTING, or explicitly allow provider replacement.");
  }

  const installBge = resolved === INSTALL_MODES.ISOLATED;
  const configureProvider = installBge;
  const enableActiveMemory = resolved !== INSTALL_MODES.SIDECAR;
  const indexMemory = resolved !== INSTALL_MODES.SIDECAR;

  return {
    requestedMode: requested,
    resolvedMode: resolved,
    reason,
    existingOpenClaw: Boolean(configExists),
    existingSemanticProvider: semanticConfigured,
    existingProvider: provider || null,
    existingModel: model || null,
    vectorEnabled,
    embeddingProbeOk: Boolean(embeddingProbeOk),
    vectorReady,
    installBge,
    configureProvider,
    enableActiveMemory,
    indexMemory,
    gatewayLoaded,
    gatewayRunning,
    installGateway: !gatewayLoaded,
    startGateway: !gatewayRunning,
    restartGateway: gatewayLoaded && gatewayRunning,
    preserveExistingGateway: gatewayLoaded,
    changes: [
      "snapshot_openclaw_config_and_vault_plugin",
      "install_or_upgrade_okf_plugins",
      "append_okf_export_path"
    ].concat(
      installBge ? ["install_isolated_cpu_bge", "configure_openclaw_for_isolated_bge"] : [],
      !gatewayLoaded ? ["install_gateway_service"] : ["preserve_existing_gateway_service"],
      resolved === INSTALL_MODES.SIDECAR ? ["preserve_existing_memory_provider_and_active_memory"] : []
    )
  };
}
