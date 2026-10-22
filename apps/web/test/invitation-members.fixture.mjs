export async function selectInvitationMember(page, index, label) {
  await page.getByRole('combobox', { name: 'Workspace member', exact: true }).nth(index).click();
  await page.getByRole('option', { name: label, exact: true }).click();
}
