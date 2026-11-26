// The routed area of the app frame plus the bottom command bar. A route hides the bar by declaring
// `hideCommandBar` (a page with its own composer); the frame never names a page.
import type { ComponentType } from 'preact';
import { Route, Switch, useLocation, useRouter } from 'wouter-preact';
import { CommandBar } from '@/components/CommandBar';
import { commandBarHidden } from '@/lib/command-bar';

export interface AppRoute {
  path: string;
  component: ComponentType<any>;
  hideCommandBar?: boolean;
  /** wrap in the padded module page container (module pages) */
  modulePage?: boolean;
}

export function AppMain({ routes, notFound }: { routes: readonly AppRoute[]; notFound: ComponentType<any> }) {
  const [loc] = useLocation();
  const { parser } = useRouter();
  const hidden = commandBarHidden(loc, routes, parser);
  return (
    <>
      <main class="app-main">
        <Switch>
          {routes.map((r) => (
            <Route key={r.path} path={r.path}>
              {(params) => {
                const C = r.component;
                const page = <C {...(params as Record<string, string>)} />;
                return r.modulePage ? <div class="page module-page">{page}</div> : page;
              }}
            </Route>
          ))}
          <Route component={notFound} />
        </Switch>
      </main>
      {!hidden && <CommandBar />}
    </>
  );
}
