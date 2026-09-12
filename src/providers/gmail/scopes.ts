export const gmailIdentityScope = "openid";
export const gmailReadonlyScope = "https://www.googleapis.com/auth/gmail.readonly";
export const gmailModifyScope = "https://www.googleapis.com/auth/gmail.modify";
export const gmailComposeScope = "https://www.googleapis.com/auth/gmail.compose";
export const gmailSendScope = "https://www.googleapis.com/auth/gmail.send";
export const gmailLabelsScope = "https://www.googleapis.com/auth/gmail.labels";
export const gmailSettingsBasicScope = "https://www.googleapis.com/auth/gmail.settings.basic";

export const gmailSyncReadScopes: string[] = [gmailReadonlyScope, gmailModifyScope, "https://mail.google.com/"];

export const gmailReadScopes: string[] = [gmailReadonlyScope];
export const gmailModifyScopes: string[] = [gmailModifyScope];
export const gmailComposeScopes: string[] = [gmailComposeScope];
export const gmailSendScopes: string[] = [gmailSendScope];
export const gmailLabelScopes: string[] = [gmailLabelsScope];
export const gmailSettingsBasicScopes: string[] = [gmailSettingsBasicScope];

export const gmailOAuthScopes: string[] = [
  gmailIdentityScope,
  gmailModifyScope,
  gmailLabelsScope,
  gmailSettingsBasicScope,
];
