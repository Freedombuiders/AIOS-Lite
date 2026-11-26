import { fireEvent, screen } from '@testing-library/react-native';
import { CloudError } from '@/api/errors';
import { detail, release } from '@/test/fixtures';
import { fakeApi, renderScreen } from '@/test/helpers';
import PackScreen from '../store/[id]';

const mockScreenOptions = jest.fn();
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: 'tra-va-qua-tang-co-ban' }),
  Stack: { Screen: (props: { options: unknown }) => { mockScreenOptions(props.options); return null; } },
}));

describe('Pack detail screen', () => {
  it('shows summary, version, size, licence, author, notes and the file list', async () => {
    const getPack = jest.fn(async () => detail());
    await renderScreen(<PackScreen />, { api: fakeApi({ getPack }) });
    expect(await screen.findByText('Bài học nội dung cho shop trà')).toBeTruthy();
    expect(getPack).toHaveBeenCalledWith('tra-va-qua-tang-co-ban', expect.anything());
    const facts = screen.getByTestId('pack-facts');
    for (const text of ['1.2.0', '145 KB', 'CC-BY-4.0', 'AgenticOS', 'tra', '12']) expect(facts).toHaveTextContent(text, { exact: false });
    expect(screen.getByText('Các file trong gói (3)')).toBeTruthy();
    expect(screen.getByText('notes/bai-hoc/video-huong-dan-ngan.md')).toBeTruthy();
    expect(screen.getByText('assets/bia.png')).toBeTruthy();
    expect(mockScreenOptions).toHaveBeenCalledWith({ title: 'Trà và quà tặng: bộ khởi đầu' });
  });

  it('the install button says it is coming: disabled, with the reason beside it, and nothing is downloaded', async () => {
    const getPack = jest.fn(async () => detail());
    const api = fakeApi({ getPack });
    await renderScreen(<PackScreen />, { api });
    const button = await screen.findByTestId('install-button');
    expect(button.props.accessibilityState).toMatchObject({ disabled: true });
    expect(screen.getByText('Cài xuống máy tính')).toBeTruthy();
    expect(screen.getByTestId('install-coming')).toHaveTextContent('Sắp có', { exact: false });
    await fireEvent.press(button);
    // The fake API throws on any call it was not given, so pressing the button reached nothing but the one read.
    expect(getPack).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('install-button').props.accessibilityState).toMatchObject({ disabled: true });
  });

  it('is honest when the licence or author is missing and when a pack has no release', async () => {
    await renderScreen(<PackScreen />, {
      api: fakeApi({ getPack: async () => detail({ license: null, author: null, summary: null, latest: release({ license: null, author: null, size: null, notesCount: null }) }) }),
    });
    expect(await screen.findByText('Gói này chưa có mô tả.')).toBeTruthy();
    expect(screen.getByTestId('pack-facts')).toHaveTextContent('Chưa rõ', { exact: false });
  });

  it('shows "no release" for an admin looking at an unreleased pack', async () => {
    await renderScreen(<PackScreen />, { api: fakeApi({ getPack: async () => detail({ latest: null, releases: [], files: [], license: null, author: null }) }) });
    expect(await screen.findByTestId('no-release')).toBeTruthy();
    expect(screen.getByText('Chưa có danh sách file.')).toBeTruthy();
  });

  it('pack not found (404) says so and can retry', async () => {
    const getPack = jest.fn().mockRejectedValueOnce(new CloudError('not_found', 404)).mockResolvedValueOnce(detail());
    await renderScreen(<PackScreen />, { api: fakeApi({ getPack }) });
    expect(await screen.findByText('Không tìm thấy mục này. Có thể nó đã bị gỡ.')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('retry'));
    expect(await screen.findByText('Bài học nội dung cho shop trà')).toBeTruthy();
  });

  it('offline shows the network message, not a spinner', async () => {
    await renderScreen(<PackScreen />, { api: fakeApi({ getPack: async () => { throw new CloudError('network'); } }) });
    expect(await screen.findByText('Không kết nối được mạng. Kiểm tra Wi-Fi hoặc 4G rồi thử lại.')).toBeTruthy();
    expect(screen.queryByTestId('loading')).toBeNull();
  });
});
