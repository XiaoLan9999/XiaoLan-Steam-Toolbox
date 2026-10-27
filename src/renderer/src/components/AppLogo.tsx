import appLogo from '../assets/app-logo.png'
import { useI18n } from '../i18n'

export function AppLogo({ className, size }: { className: string; size: number }): React.JSX.Element {
  const { t } = useI18n()
  return <img className={`app-logo ${className}`} src={appLogo}
    alt={t('小蓝Steam工具箱标志', 'XiaoLan Steam Toolbox logo')}
    width={size} height={size} draggable={false} />
}
