import { useEffect, useState } from 'preact/hooks';
import { useLocation } from 'wouter-preact';
import { PageState } from '@/components/PageState';
import { apiGet } from '@/lib/api';
import { CareCustomers } from './CareCustomers';

/** Where the customer screens live now (module crm). */
export const CRM_CUSTOMERS_PATH = '/m/crm/stages';

/**
 * /m/care/customers is kept as an address: while the crm module is on it sends you to the new customer screens
 * (Giai đoạn / Tất cả khách / Hồ sơ). Without crm there is nothing to send you to, so the old list still shows.
 * The crm module's own status route tells the two cases apart (a module that is off has no routes).
 */
export function CareCustomersEntry() {
  const [, navigate] = useLocation();
  const [crmOn, setCrmOn] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    apiGet('/api/m/crm/status').then(() => live && setCrmOn(true)).catch(() => live && setCrmOn(false));
    return () => { live = false; };
  }, []);
  useEffect(() => {
    if (crmOn) navigate(CRM_CUSTOMERS_PATH, { replace: true });
  }, [crmOn, navigate]);
  if (crmOn === false) return <CareCustomers />;
  return <PageState loading />;
}
