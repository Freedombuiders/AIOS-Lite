import { defineWebModule } from '@/module-host/contracts';
import { CrmAll } from './pages/CrmAll';
import { CrmCustomer } from './pages/CrmCustomer';
import { CrmStages } from './pages/CrmStages';

/**
 * The customer screens. The menu entry "Khách hàng" is care's (/m/care/customers, which sends you here while this
 * module is on), so there is one entry, not two.
 */
export default defineWebModule({
  id: 'crm',
  routes: [
    { path: '/m/crm', component: CrmStages },
    { path: '/m/crm/stages', component: CrmStages },
    { path: '/m/crm/all', component: CrmAll },
    { path: '/m/crm/customer/:id', component: CrmCustomer },
  ],
});
