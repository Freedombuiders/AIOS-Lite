import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { CloudError } from '@/api/errors';
import { detail, listItem, release } from '@/test/fixtures';
import { fakeApi, renderScreen } from '@/test/helpers';
import StoreScreen from '../(tabs)/store';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }), Stack: { Screen: () => null } }));

beforeEach(() => { mockPush.mockClear(); });

describe('Store list screen', () => {
  it('shows a loading state, then the packs with module, version and size', async () => {
    let resolve!: (v: { items: ReturnType<typeof listItem>[] }) => void;
    const listPacks = jest.fn(() => new Promise<{ items: ReturnType<typeof listItem>[] }>((r) => { resolve = r; }));
    await renderScreen(<StoreScreen />, { api: fakeApi({ listPacks }) });
    expect(screen.getByTestId('loading')).toBeTruthy();
    await act(async () => { resolve({ items: [listItem(), listItem({ id: 'dream-kenh', module: 'dream', name: 'Kênh Dream 100', summary: null, latest: release({ version: '0.3.0', size: 2_500_000 }) })] }); });
    expect(await screen.findByText('Trà và quà tặng: bộ khởi đầu')).toBeTruthy();
    expect(screen.getByText('Bản 1.2.0 · 145 KB')).toBeTruthy();
    expect(screen.getByText('Kênh Dream 100')).toBeTruthy();
    expect(screen.getByText('Bản 0.3.0 · 2,4 MB')).toBeTruthy();
    expect(screen.queryByTestId('loading')).toBeNull();
    expect(listPacks).toHaveBeenCalledWith({ module: undefined, q: '' }, expect.anything());
  });

  it('opens the pack detail when a card is pressed', async () => {
    await renderScreen(<StoreScreen />, { api: fakeApi({ listPacks: async () => ({ items: [listItem()] }) }) });
    await fireEvent.press(await screen.findByLabelText('Mở gói Trà và quà tặng: bộ khởi đầu'));
    expect(mockPush).toHaveBeenCalledWith('/store/tra-va-qua-tang-co-ban');
  });

  it('filters by module and asks the cloud for that module', async () => {
    const listPacks = jest.fn(async () => ({ items: [listItem()] }));
    await renderScreen(<StoreScreen />, { api: fakeApi({ listPacks }) });
    await screen.findByText('Trà và quà tặng: bộ khởi đầu');
    await fireEvent.press(screen.getByTestId('filter-dream'));
    await waitFor(() => expect(listPacks).toHaveBeenLastCalledWith({ module: 'dream', q: '' }, expect.anything()));
    expect(screen.getByTestId('filter-dream').props.accessibilityState).toMatchObject({ checked: true });
    expect(screen.getByTestId('filter-all').props.accessibilityState).toMatchObject({ checked: false });
  });

  it('searches after a short pause, and clears the search with a labelled button', async () => {
    jest.useFakeTimers();
    try {
      const listPacks = jest.fn(async () => ({ items: [listItem()] }));
      await renderScreen(<StoreScreen />, { api: fakeApi({ listPacks }) });
      await act(async () => { await jest.advanceTimersByTimeAsync(0); });
      await fireEvent.changeText(screen.getByTestId('search-input'), 'trà');
      expect(listPacks).toHaveBeenCalledTimes(1);
      await act(async () => { await jest.advanceTimersByTimeAsync(350); });
      expect(listPacks).toHaveBeenLastCalledWith({ module: undefined, q: 'trà' }, expect.anything());
      await fireEvent.press(screen.getByLabelText('Xoá tìm kiếm'));
      expect((screen.getByTestId('search-input').props as { value: string }).value).toBe('');
    } finally {
      jest.useRealTimers();
    }
  });

  it('says the store is empty when there are no packs and no filter', async () => {
    await renderScreen(<StoreScreen />, { api: fakeApi({ listPacks: async () => ({ items: [] }) }) });
    expect(await screen.findByText('Kho chưa có gói nào')).toBeTruthy();
  });

  it('says nothing matches when a filter is on', async () => {
    await renderScreen(<StoreScreen />, { api: fakeApi({ listPacks: async () => ({ items: [] }) }) });
    await screen.findByText('Kho chưa có gói nào');
    await fireEvent.press(screen.getByTestId('filter-crm'));
    expect(await screen.findByText('Không có gói nào khớp')).toBeTruthy();
  });

  it('offline: shows a clear message and retries on demand instead of spinning', async () => {
    const listPacks = jest.fn()
      .mockRejectedValueOnce(new CloudError('network'))
      .mockResolvedValueOnce({ items: [listItem()] });
    await renderScreen(<StoreScreen />, { api: fakeApi({ listPacks }) });
    expect(await screen.findByText('Không kết nối được mạng. Kiểm tra Wi-Fi hoặc 4G rồi thử lại.')).toBeTruthy();
    expect(screen.queryByTestId('loading')).toBeNull();
    await fireEvent.press(screen.getByTestId('retry'));
    expect(await screen.findByText('Trà và quà tặng: bộ khởi đầu')).toBeTruthy();
    expect(listPacks).toHaveBeenCalledTimes(2);
  });

  it('shows a server error and a timeout in words', async () => {
    const listPacks = jest.fn().mockRejectedValueOnce(new CloudError('timeout')).mockRejectedValueOnce(new CloudError('server', 500));
    await renderScreen(<StoreScreen />, { api: fakeApi({ listPacks }) });
    expect(await screen.findByText('Máy chủ phản hồi quá lâu. Thử lại sau ít phút.')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('retry'));
    expect(await screen.findByText('Máy chủ đang gặp sự cố. Thử lại sau ít phút.')).toBeTruthy();
  });

  it('speaks English when asked to', async () => {
    await renderScreen(<StoreScreen />, { lang: 'en', api: fakeApi({ listPacks: async () => ({ items: [listItem()] }) }) });
    expect(await screen.findByText('Version 1.2.0 · 145 KB')).toBeTruthy();
    expect(screen.getByTestId('filter-all')).toHaveTextContent('All');
  });

  it('labels the search box and the filters, and every touch target is at least 44 points', async () => {
    await renderScreen(<StoreScreen />, { api: fakeApi({ listPacks: async () => ({ items: [listItem()] }) }) });
    await screen.findByText('Trà và quà tặng: bộ khởi đầu');
    expect(screen.getByLabelText('Tìm gói dữ liệu')).toBeTruthy();
    for (const id of ['filter-all', 'filter-brain', 'filter-learn', 'filter-dream', 'filter-crm']) {
      expect(minHeight(screen.getByTestId(id))).toBeGreaterThanOrEqual(44);
    }
  });
});

function minHeight(node: { props: { style?: unknown } }): number {
  const flat = Object.assign({}, ...[node.props.style].flat(Infinity).filter(Boolean)) as { minHeight?: number; height?: number };
  return flat.minHeight ?? flat.height ?? 0;
}

void detail;
