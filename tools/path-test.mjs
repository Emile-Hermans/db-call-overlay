// Checks that source paths shorten to repo-relative wherever the code is checked out.
import { Store } from '../server/store.mjs'

const store = new Store({ repoRoots: [] })

const cases = [
  [String.raw`C:\dev\MyApp\src\Shop.Orders\Services\OrderService.cs`, String.raw`src\Shop.Orders\Services\OrderService.cs`],
  [String.raw`D:\work\checkout\Core\Billing\InvoiceService.cs`, String.raw`Core\Billing\InvoiceService.cs`],
  [String.raw`C:\Users\someone\repos\feature-branch\Infrastructure\Repositories\OrderRepository.cs`, String.raw`Infrastructure\Repositories\OrderRepository.cs`],
  [String.raw`\\server\share\MyApp\Frontend\components\Grid.vue`, String.raw`Frontend\components\Grid.vue`],
  // nothing recognisable: leave it alone rather than mangle it
  [String.raw`C:\somewhere\else\Random\File.cs`, String.raw`C:\somewhere\else\Random\File.cs`],
]

let failures = 0
for (const [input, expected] of cases) {
  const actual = store.shortenPath(input)
  const ok = actual === expected
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${input}\n      -> ${actual}${ok ? '' : `\n      expected ${expected}`}`)
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
