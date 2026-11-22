<script lang="ts">
  import MeAvatarSetting from '../../../lib/components/MeAvatarSetting.svelte';
  import { page } from '$app/state';
  import ApiTokensSetting from '../../../lib/components/ApiTokensSetting.svelte';
  import MeInvitations from '../../../lib/components/MeInvitations.svelte';
  import MePasswordSetting from '../../../lib/components/MePasswordSetting.svelte';
  import MeThemeSetting from '../../../lib/components/MeThemeSetting.svelte';
  import PageHead from '../../../lib/components/PageHead.svelte';
  import { previewWithoutAttachments } from '../../../lib/preview-without-attachments.ts';
  import { t } from '../../../lib/vocabulary.svelte.ts';
  import type { PageProps } from './$types';

  // マイプロフィールの画面（me.html）。上から「届いた招待」（MeInvitations。本文の先頭に囲みの知らせで）、プロフィール画像と
  // 「テーマ」の節（MeThemeSetting。選んだ瞬間に保存する）、パスワード（パスワードでログインした人だけ）、API トークン（ApiTokensSetting）の節。
  // ほかの節（1日の基準、稼働期間、休み、月の基準の上書き、積載量の合計）は #66 で足す（まだ無いことを知らせる文は出さない）。
  // テーマは組織の枠が読んだ値（自分のテーマと組織の既定）を受け取る
  let { data }: PageProps = $props();

  const slug = $derived(page.params.slug ?? '');
  const me = $derived(data.organization?.me ?? null);
</script>

<svelte:head>
  <title>{t('pageTitle', { page: t('pageMe'), app: t('appName') })}</title>
</svelte:head>

<PageHead title={t('pageMe')} eyebrow={me?.name} />

<!-- 届いた招待（この組織のワークスペースへの承諾待ち）。招待が無ければ何も出さない -->
<MeInvitations {slug} list={data.invitations} />

{#if data.organization}
  <div class="settings">
    {#if !previewWithoutAttachments}
      {#key slug}
        <MeAvatarSetting
          {slug}
          userId={data.organization.me.id}
          name={data.organization.me.name}
          image={data.organization.me.avatar_url}
        />
      {/key}
    {/if}
    <MeThemeSetting {slug} theme={data.organization.me.theme} />
  </div>
{/if}

{#if data.loginProvider === 'password'}
  <MePasswordSetting />
{/if}

<ApiTokensSetting
  initial={data.tokens}
  canCreate={data.canCreateToken}
  loginProvider={data.loginProvider}
  slug={data.slug}
/>
