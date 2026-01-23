import Footer from "./components/Footer.js";
import {createMuiTheme, ThemeProvider} from "@material-ui/core/styles";
import MainArea from "./components/MainArea";


const appTheme = createMuiTheme({
  palette: {
      primary: {
        main: "#darkgray"
      },
      secondary: {
        main: '#1976D2'
      }
  }
});


function App() {
  return (
    <div className="App">
        <ThemeProvider theme={appTheme}>
            <MainArea />
            <Footer/>
        </ThemeProvider>
    </div>
  );
}

export default App;