// Runs both mock CRMs:
//   VinSolutions-style  http://localhost:4101/vinconnect/
//   CDK-style           http://localhost:4102/login   (user demo.sales / mock-crm-2026)
//   SugarCRM-family     http://localhost:4103/app/    (auto sign-in, then a
//                       one-time "confirm your time zone" screen)
//   Drawer CRM          http://localhost:4104/crm/    (records open in a drawer
//                       when a row is clicked; they have no address)
//
// POST /__admin/layout?variant=2 on either port switches that CRM to its
// "new release" layout, to exercise re-mapping; variant=1 switches back.
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { createVinSolutionsHandler } from './vinsolutions.js';
import { createCdkHandler, MOCK_CDK_USER, MOCK_CDK_PASSWORD } from './cdk.js';
import { createSugarHandler } from './sugar.js';
import { createDrawerHandler } from './drawer.js';
import { json, serveAsset } from './http-utils.js';

function createServer(name, handler, state) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/__admin/layout') {
        if (req.method === 'POST') state.layout = url.searchParams.get('variant') === '2' ? 2 : 1;
        return json(res, { crm: name, layout: state.layout });
      }
      if (url.pathname.startsWith('/assets/')) return await serveAsset(res, url.pathname);
      await handler(req, res, url);
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String(error?.stack || error));
    }
  });
}

const listen = (server, port) =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });

export async function startMockCrms({ vinPort = 4101, cdkPort = 4102, sugarPort = 4103, drawerPort = 4104 } = {}) {
  const vinState = { layout: 1 };
  const cdkState = { layout: 1 };
  const vin = createServer('vinsolutions', createVinSolutionsHandler(vinState), vinState);
  const cdk = createServer('cdk', createCdkHandler(cdkState), cdkState);
  const sugarState = { layout: 1 }; // the SugarCRM-family mock has one layout
  const sugar = createServer('sugar', createSugarHandler(), sugarState);
  const drawerState = { layout: 1 }; // one layout; counts Delete presses (deletes)
  const drawer = createServer('drawer', createDrawerHandler(drawerState), drawerState);
  const ports = { vinsolutions: await listen(vin, vinPort), cdk: await listen(cdk, cdkPort), sugar: await listen(sugar, sugarPort), drawer: await listen(drawer, drawerPort) };
  return {
    ports,
    urls: {
      vinsolutions: `http://localhost:${ports.vinsolutions}/vinconnect/`,
      cdk: `http://localhost:${ports.cdk}/login`,
      sugar: `http://localhost:${ports.sugar}/app/`,
      drawer: `http://localhost:${ports.drawer}/crm/`,
    },
    drawerState,
    setLayout(crm, variant) {
      ({ vinsolutions: vinState, cdk: cdkState, sugar: sugarState, drawer: drawerState })[crm].layout = variant;
    },
    close: () => Promise.all([vin, cdk, sugar, drawer].map((s) => new Promise((r) => s.close(r)))),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mocks = await startMockCrms({
    vinPort: Number(process.env.MOCK_VIN_PORT || 4101),
    cdkPort: Number(process.env.MOCK_CDK_PORT || 4102),
    sugarPort: Number(process.env.MOCK_SUGAR_PORT || 4103),
    drawerPort: Number(process.env.MOCK_DRAWER_PORT || 4104),
  });
  console.log(`VinSolutions-style mock: ${mocks.urls.vinsolutions}`);
  console.log(`CDK-style mock:          ${mocks.urls.cdk}  (user ${MOCK_CDK_USER} / ${MOCK_CDK_PASSWORD})`);
  console.log(`SugarCRM-family mock:    ${mocks.urls.sugar}`);
  console.log(`Drawer CRM mock:         ${mocks.urls.drawer}`);
}
