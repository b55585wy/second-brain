import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Layout } from './Layout';

function renderLayout(initialEntry = '/') {
  return render(<MemoryRouter initialEntries={[initialEntry]}><Routes><Route element={<Layout />}><Route index element={<p>今天内容</p>} /><Route path="plan" element={<p>计划内容</p>} /><Route path="projects" element={<p>项目内容</p>} /></Route></Routes></MemoryRouter>);
}

describe('主导航与高级工具', () => {
  it('顶层只有今天和偏好设置，高级工具包含全部旧入口及每日计划', async () => {
    const user = userEvent.setup();
    renderLayout();
    const navigation = screen.getByRole('navigation', { name: '主导航' });
    expect(navigation.querySelector(':scope > ul')?.textContent).toBe('今天偏好设置');
    expect(screen.getByRole('link', { name: '项目', hidden: true })).not.toBeVisible();
    const disclosure = screen.getByText('高级工具');
    disclosure.focus();
    await user.keyboard('{Enter}');
    for (const [name, href] of [['项目', '/projects'], ['知识', '/knowledge'], ['复习', '/review'], ['练习与输出', '/practice'], ['对话采集', '/codex'], ['每日计划', '/plan']]) {
      expect(screen.getByRole('link', { name })).toHaveAttribute('href', href);
    }
  });

  it('移动导航展开后可通过链接和遮罩关闭，并保持 aria-expanded 同步', async () => {
    const user = userEvent.setup();
    renderLayout();
    const trigger = screen.getByRole('button', { name: '打开导航' });
    await user.click(trigger);
    expect(screen.getByRole('button', { name: '关闭导航' })).toHaveAttribute('aria-expanded', 'true');
    await user.click(screen.getByText('高级工具'));
    await user.click(screen.getByRole('link', { name: '每日计划' }));
    expect(screen.getByText('计划内容')).toBeVisible();
    expect(screen.getByRole('button', { name: '打开导航' })).toHaveAttribute('aria-expanded', 'false');

    await user.click(screen.getByRole('button', { name: '打开导航' }));
    await user.click(screen.getByRole('button', { name: '关闭导航遮罩' }));
    expect(screen.getByRole('button', { name: '打开导航' })).toHaveAttribute('aria-expanded', 'false');
  });
});
