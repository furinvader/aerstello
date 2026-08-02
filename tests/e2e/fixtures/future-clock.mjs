const nativeNow = Date.now.bind(Date);

Date.now = () => nativeNow() + 60 * 60 * 1000;
