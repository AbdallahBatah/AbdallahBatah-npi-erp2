// D-26 (T-48b): the six flows and the places that must keep seeing five.
import { visibleFlowsOf as visibleFlowsOfFirm } from '../src/agents/context';
import {
  DOCUMENT_FLOWS,
  FLOW_REQUIRED_MODULE,
  FLOW_REQUIRED_PERMISSION,
  FLOW_TYPES,
  AcceptedDocTypeSchema,
} from '../src/onboarding/profile.schema';
import { usageFlowLabelAr, flowOfEvent } from '../src/audit/cost';
import { USAGE_FLOWS } from '../src/audit/usage-types';
import { t } from '../src/i18n/ar';

describe('FLOW_TYPES / DOCUMENT_FLOWS', () => {
  it('six flows: the five document flows and the administrative one', () => {
    expect([...DOCUMENT_FLOWS]).toEqual(['customer_contract', 'pr', 'po', 'grn', 'vendor_bill']);
    expect([...FLOW_TYPES]).toEqual([...DOCUMENT_FLOWS, 'user_permissions']);
  });

  it('the administrative flow needs admin.user.manage and no module', () => {
    expect(FLOW_REQUIRED_PERMISSION.user_permissions).toBe('admin.user.manage');
    expect(FLOW_REQUIRED_MODULE.user_permissions).toBeNull();
    for (const flow of DOCUMENT_FLOWS) expect(FLOW_REQUIRED_MODULE[flow]).not.toBeNull();
  });

  it('a profile pack’s document type can map to a document flow only', () => {
    const base = { key: 'doc', labelAr: 'مستند' };
    expect(AcceptedDocTypeSchema.safeParse({ ...base, flow: 'pr' }).success).toBe(true);
    expect(AcceptedDocTypeSchema.safeParse({ ...base, flow: null }).success).toBe(true);
    expect(AcceptedDocTypeSchema.safeParse({ ...base, flow: 'user_permissions' }).success).toBe(false);
  });
});

describe('firm visibleFlowsOf (src/agents/context.ts)', () => {
  it('a firm that has not run the setup sees every flow, the administrative one included', () => {
    expect(visibleFlowsOfFirm(null)).toEqual([...FLOW_TYPES]);
  });

  it('switching modules off hides the document flows but never the module-free administrative flow', () => {
    expect(visibleFlowsOfFirm(['commercial'])).toEqual(['customer_contract', 'user_permissions']);
    expect(visibleFlowsOfFirm(['crm'])).toEqual(['user_permissions']);
    expect(visibleFlowsOfFirm(['procurement', 'commercial'])).toEqual([...FLOW_TYPES]);
  });
});

describe('usage accounting', () => {
  it('extract_user_permissions (and its edit) are attributed to the flow, with its Arabic label', () => {
    expect(flowOfEvent('extract_user_permissions')).toBe('user_permissions');
    expect(flowOfEvent('extract_user_permissions_edit')).toBe('user_permissions');
    expect(USAGE_FLOWS).toContain('user_permissions');
    expect(usageFlowLabelAr('user_permissions')).toBe(t('flow.user_permissions'));
  });
});
