import { Redirect, Route, Switch } from 'wouter';
import { LoginPage, RequestAccessPage } from './auth-pages';
import { GuestPage } from './guest-page';
import { HostShell } from './host-shell';
import { AccountPage, BillDetailPage, BillsPage, DashboardPage, GuestsPage, OrdersPage, ProductsPage, RequestsPage, RoomsPage, SettingsPage, TakeOrdersPage } from './host-pages';

export function App() {
  return <Switch>
    <Route path="/"><Redirect to="/login"/></Route>
    <Route path="/login"><LoginPage/></Route>
    <Route path="/guest/request"><RequestAccessPage/></Route>
    <Route path="/guest"><GuestPage/></Route>
    <Route path="/app"><HostShell><HostRoutes/></HostShell></Route>
    <Route path="/app/*"><HostShell><HostRoutes/></HostShell></Route>
    <Route><Redirect to="/"/></Route>
  </Switch>;
}

function HostRoutes(){
  return <Switch>
    <Route path="/app"><DashboardPage/></Route>
    <Route path="/app/orders/new"><TakeOrdersPage/></Route>
    <Route path="/app/orders"><OrdersPage/></Route>
    <Route path="/app/bills/:id"><BillDetailPage/></Route>
    <Route path="/app/bills"><BillsPage/></Route>
    <Route path="/app/guests"><GuestsPage/></Route>
    <Route path="/app/rooms"><RoomsPage/></Route>
    <Route path="/app/products"><ProductsPage/></Route>
    <Route path="/app/requests"><RequestsPage/></Route>
    <Route path="/app/account"><AccountPage/></Route>
    <Route path="/app/settings"><SettingsPage/></Route>
    <Route><Redirect to="/app"/></Route>
  </Switch>;
}
