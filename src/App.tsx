import { useEffect, useState, useCallback } from "react";
import { invoke } from '@tauri-apps/api'

let count = 0;

const App = () => {
  useEffect(() => {
    alert('trying to request userMedia');
    navigator.mediaDevices.getUserMedia({
      audio: true,
    });
  })
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

  const style = { backgroundColor: 'pink', width: '10px' };

  const getArray = useCallback(async () => {
    const result: number[] = await invoke('get_array')
    const el = document.getElementById('output')
    if (!el) return
    // if (count >= 44) {
    // 	count = 0;
    // 	el.innerText = ''
    // } else {
    // 	count += 1
    // }
    // const sum = result.reduce((res, n) => res + n, 0)

    el.innerText = result.reduce((acc, n) => acc + n, 0).toString();
  }, [])

  useEffect(() => {
    // setInterval(getArray, 1000 / 1)
  })
  // useEffect(() => {
  // invoke('increment_counter', { delta: 0 }).then((result) => setCounter(result as number))
  // }, [setCounter])

  return (
    <div>
      <button onClick={increment}>increment</button>
      <button onClick={reset}>reset</button>
      <button onClick={getArray}>random array</button>
      <div id="output"></div>
      {counter}
    </div>
  )
}

export default App;