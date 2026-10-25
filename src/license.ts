import { UserError } from './service';

/** The invocation's app context as Forge reports it on the server; never anything a client sent. */
export interface AppLicense {
  environmentType?: unknown;
  license?: unknown;
}

/** Paid via Atlassian: a license object decides, and a trial is an active license. Forge gives
 * development and staging installations no license object unless they were installed with
 * `--license`, so those keep working; in production a missing license counts as unlicensed. */
export function licensed({ environmentType, license }: AppLicense) {
  if (license && typeof license === 'object') {
    // `isActive` is the deprecated name of `active`.
    const { active, isActive } = license as { active?: unknown; isActive?: unknown };
    return (typeof active === 'boolean' ? active : isActive) === true;
  }
  return environmentType === 'DEVELOPMENT' || environmentType === 'STAGING';
}

const unlicensedMessage =
  'Agent Prompts for Jira has no active subscription on this site. A site administrator can subscribe in Atlassian Administration.';

export function requireLicense(app: AppLicense) {
  if (!licensed(app)) throw new UserError(unlicensedMessage);
}
