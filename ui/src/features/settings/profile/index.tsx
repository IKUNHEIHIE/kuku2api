import { ContentSection } from '../components/content-section'
import { ProfileForm } from './profile-form'

export function SettingsProfile() {
  return (
    <ContentSection
      title='API 服务与令牌配置'
      desc='配置 kuku2api 后端服务基址、普通 API Key 以及号池管理端 ADMIN_TOKEN 凭证。'
    >
      <ProfileForm />
    </ContentSection>
  )
}
