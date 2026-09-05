export type QuestionStatus = 'pending' | 'ready' | 'rejected'

export interface Source {
  readonly title: string
  readonly url: string
  readonly publisher?: string
}

/** 一个问答页面的完整领域模型。所有字段均为只读——上层只能派生新对象，不得就地修改。 */
export interface Question {
  readonly id: string
  readonly slug: string
  readonly fingerprint: string
  readonly title: string
  readonly status: QuestionStatus
  readonly answerMarkdown: string | null
  readonly sources: readonly Source[]
  readonly views: number
  readonly createdAt: number
  readonly updatedAt: number
  /** 人工或定时任务强制降级：即使通过质量门禁也不进索引 */
  readonly demoted?: boolean
  readonly tags?: readonly string[]
}
