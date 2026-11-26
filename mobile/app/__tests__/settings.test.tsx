import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { CloudError } from '@/api/errors';
import { me, session, user } from '@/test/fixtures';
import { fakeApi, renderScreen } from '@/test/helpers';
import SettingsScreen from '../(tabs)/settings';

describe('Settings screen', () => {
  it('shows the account, and the sessions with the current one marked and not revocable', async () => {
    await renderScreen(<SettingsScreen />, { api: fakeApi({ me: async () => me() }) });
    expect(await screen.findByText('Chị Lan')).toBeTruthy();
    expect(screen.getByTestId('account-email')).toHaveTextContent('lan@example.com');
    expect(screen.getByText('iPhone của Lan · Thiết bị này')).toBeTruthy();
    expect(screen.getByText('Máy ở nhà')).toBeTruthy();
    expect(screen.queryByTestId('revoke-ses_1')).toBeNull();
    expect(screen.getByTestId('revoke-ses_2')).toBeTruthy();
  });

  it('flags an admin', async () => {
    await renderScreen(<SettingsScreen />, { api: fakeApi({ me: async () => me({ user: user({ role: 'admin' }) }) }) });
    expect(await screen.findByText('Quản trị viên')).toBeTruthy();
  });

  it('revokes another session, with a label that names it, then reloads the list', async () => {
    // The first call is the app's start-up check (the store's bootstrap), the second is the screen's own load.
    const meFn = jest.fn()
      .mockResolvedValueOnce(me())
      .mockResolvedValueOnce(me())
      .mockResolvedValue(me({ sessions: [session()] }));
    const revokeSession = jest.fn(async () => ({ ok: true as const }));
    await renderScreen(<SettingsScreen />, { api: fakeApi({ me: meFn, revokeSession }) });
    const button = await screen.findByTestId('revoke-ses_2');
    expect(button.props.accessibilityLabel).toBe('Thu hồi phiên Máy ở nhà');
    await fireEvent.press(button);
    await waitFor(() => expect(revokeSession).toHaveBeenCalledWith('ses_2'));
    await waitFor(() => expect(screen.queryByTestId('session-ses_2')).toBeNull());
    expect(screen.getByTestId('session-ses_1')).toBeTruthy();
  });

  it('says so when revoking fails, and keeps the session listed', async () => {
    const revokeSession = jest.fn(async () => { throw new CloudError('network'); });
    await renderScreen(<SettingsScreen />, { api: fakeApi({ me: async () => me(), revokeSession }) });
    await fireEvent.press(await screen.findByTestId('revoke-ses_2'));
    expect(await screen.findByTestId('revoke-error')).toHaveTextContent('Không kết nối được mạng', { exact: false });
    expect(screen.getByTestId('session-ses_2')).toBeTruthy();
  });

  it('offline: the sessions block shows an error with a retry, and the account stays visible', async () => {
    // Call 1 is the start-up check, which must succeed to be signed in; call 2 is the screen's load, which fails.
    const meFn = jest.fn().mockResolvedValueOnce(me()).mockRejectedValueOnce(new CloudError('network')).mockResolvedValueOnce(me());
    await renderScreen(<SettingsScreen />, { api: fakeApi({ me: meFn }) });
    expect(await screen.findByText('Không tải được danh sách phiên.')).toBeTruthy();
    expect(screen.getByText('Không kết nối được mạng. Kiểm tra Wi-Fi hoặc 4G rồi thử lại.')).toBeTruthy();
    expect(screen.getByTestId('account-email')).toHaveTextContent('lan@example.com');
    expect(screen.queryByTestId('loading')).toBeNull();
    await fireEvent.press(screen.getByTestId('retry'));
    expect(await screen.findByText('Máy ở nhà')).toBeTruthy();
  });

  it('signs out: ends the session on the cloud, clears the stored token and leaves the signed-in state', async () => {
    const logout = jest.fn(async () => ({ ok: true as const }));
    const api = fakeApi({ me: async () => me(), logout });
    const { store, storage } = await renderScreen(<SettingsScreen />, { api });
    await fireEvent.press(await screen.findByTestId('sign-out'));
    await waitFor(() => expect(store.getState()).toEqual({ status: 'signedOut', notice: null }));
    expect(logout).toHaveBeenCalledTimes(1);
    expect(storage.value).toBeNull();
  });

  describe('delete account', () => {
    it('asks first: nothing is deleted until the explicit confirmation', async () => {
      const deleteAccount = jest.fn(async () => ({ ok: true as const }));
      const { store } = await renderScreen(<SettingsScreen />, { api: fakeApi({ me: async () => me(), deleteAccount }) });
      await fireEvent.press(await screen.findByTestId('delete-account'));
      expect(await screen.findByText('Xoá tài khoản vĩnh viễn?')).toBeTruthy();
      expect(deleteAccount).not.toHaveBeenCalled();
      await fireEvent.press(screen.getByTestId('confirm-cancel'));
      expect(deleteAccount).not.toHaveBeenCalled();
      expect(store.getState().status).toBe('signedIn');
    });

    it('confirming deletes the account, clears the token and signs out', async () => {
      const deleteAccount = jest.fn(async () => ({ ok: true as const }));
      const { store, storage } = await renderScreen(<SettingsScreen />, { api: fakeApi({ me: async () => me(), deleteAccount }) });
      await fireEvent.press(await screen.findByTestId('delete-account'));
      await fireEvent.press(await screen.findByTestId('confirm-ok'));
      await waitFor(() => expect(deleteAccount).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(store.getState()).toEqual({ status: 'signedOut', notice: null }));
      expect(storage.value).toBeNull();
    });

    it('a failure is shown in the dialog and the user stays signed in', async () => {
      const deleteAccount = jest.fn(async () => { throw new CloudError('server', 500); });
      const { store, storage } = await renderScreen(<SettingsScreen />, { api: fakeApi({ me: async () => me(), deleteAccount }) });
      await fireEvent.press(await screen.findByTestId('delete-account'));
      await fireEvent.press(await screen.findByTestId('confirm-ok'));
      expect(await screen.findByTestId('confirm-error')).toHaveTextContent('Không xoá được tài khoản', { exact: false });
      expect(store.getState().status).toBe('signedIn');
      expect(storage.value).toBe('tok_test');
    });
  });

  it('speaks English when asked to, and every button has a name', async () => {
    await renderScreen(<SettingsScreen />, { lang: 'en', api: fakeApi({ me: async () => me() }) });
    expect(await screen.findByText('Sign out')).toBeTruthy();
    expect(screen.getByTestId('delete-account')).toHaveTextContent('Delete account');
    expect((await screen.findByTestId('revoke-ses_2')).props.accessibilityLabel).toMatch(/Revoke/);
  });
});

