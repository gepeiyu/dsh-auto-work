export function ownerOf(identity) {
  if (!identity || typeof identity.organizationId !== 'string' || typeof identity.userId !== 'string') {
    const error = new Error('authenticated tenant identity is required')
    error.code = 'AUTH_REQUIRED'; error.status = 401; throw error
  }
  return { organizationId: identity.organizationId, userId: identity.userId, role: identity.role ?? 'member' }
}

export function sameOwner(a, b) {
  return a?.organizationId === b?.organizationId && a?.userId === b?.userId
}

export async function assertTarget(tenant, identity, target) {
  const normalized = {
    sessionId: typeof target?.sessionId === 'string' ? target.sessionId.trim() : '',
    workspaceId: typeof target?.workspaceId === 'string' ? target.workspaceId.trim() : '',
    workdir: typeof target?.workdir === 'string' ? target.workdir.trim() : '',
  }
  if (!normalized.sessionId && !normalized.workspaceId && !normalized.workdir) {
    return normalized
  }
  if (!tenant) throw new Error('tenant policy service is unavailable')
  if (normalized.sessionId) {
    if (typeof tenant.assertSessionLocation === 'function') await tenant.assertSessionLocation(identity, normalized.sessionId)
    else tenant.assertSessionAccess(identity, normalized.sessionId)
  }
  if (normalized.workspaceId) tenant.assertWorkspaceLocation?.(identity, normalized.workspaceId) ?? tenant.assertWorkspaceAccess(identity, normalized.workspaceId)
  if (normalized.workdir && typeof tenant.assertWorkspacePath === 'function') {
    normalized.workdir = tenant.assertWorkspacePath(identity, normalized.workdir)
  }
  return normalized
}

export async function accessibleTargets(tenant, identity) {
  if (!tenant) throw new Error('tenant policy service is unavailable')
  const sessions = typeof tenant.listOwnedSessions === 'function'
    ? tenant.listOwnedSessions(identity).filter(row => tenant.canAccessSessionLocation ? true : tenant.canAccessSession(identity, row.id))
    : []
  const workspaces = typeof tenant.listOwnedWorkspaces === 'function'
    ? tenant.listOwnedWorkspaces(identity).filter(row => tenant.canAccessWorkspaceLocation ? true : tenant.canAccessWorkspace(identity, row.id))
    : []
  return { sessions, workspaces }
}
