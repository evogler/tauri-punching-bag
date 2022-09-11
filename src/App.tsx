import { useEffect, useState, useCallback } from "react";
import { invoke } from '@tauri-apps/api'

let count = 0;

const App = () => {
  const [counter, setCounter] = useState(-1)

	const increment = useCallback(async () => {
		let result: number = 123;
		result = await invoke('increment_counter', { delta: 1 }) as number
		setCounter(result)
	}, [setCounter])

	const reset = useCallback(async () => {
		await invoke('reset_counter')
		setCounter(0)
	}, [setCounter])

	// const [count, setCount] = useState(0);

	const randomArray = useCallback(async () => {
		const result: number[] = await invoke('random_array')
		const el = document.getElementById('output')
		if (!el) return
		if (count >= 44) {
			count = 0;
			el.innerText = ''
		} else {
			count += 1
		}
		const sum = result.reduce((res, n) => res + n, 0)

		el.innerText += ' ' + JSON.stringify(sum)
	}, [])

	useEffect(() => {
		setInterval(randomArray, 1000 / 44)
	})
  // useEffect(() => {
    // invoke('increment_counter', { delta: 0 }).then((result) => setCounter(result as number))
  // }, [setCounter])

  return (
    <div>
   		<button onClick={increment}>increment</button>
			<button onClick={reset}>reset</button>
			<button onClick={randomArray}>random array</button>
			<div id="output"></div>
			{counter}
    </div>
  )
}

export default App;
