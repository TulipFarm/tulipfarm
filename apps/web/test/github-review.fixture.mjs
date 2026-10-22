export async function openGitHubReview(page, id) {
  await page
    .locator(`[id="github-batch:${id}"]`)
    .getByRole('button', { name: 'View GitHub changes', exact: true })
    .click();
}

export async function openGitHubDetails(review) {
  for (const button of await review.getByRole('button', { name: 'Exact change', exact: true }).all()) {
    if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click();
  }
}
