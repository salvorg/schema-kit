import java.io.File;
import javax.xml.XMLConstants;
import javax.xml.transform.stream.StreamSource;
import javax.xml.validation.Schema;
import javax.xml.validation.SchemaFactory;
import javax.xml.validation.Validator;

public class Validate {
  public static void main(String[] args) throws Exception {
    SchemaFactory factory = SchemaFactory.newInstance(
        "http://www.w3.org/XML/XMLSchema/v1.1",
        "org.apache.xerces.jaxp.validation.XMLSchema11Factory",
        Validate.class.getClassLoader());
    Schema schema;
    try {
      schema = factory.newSchema(new File(args[0]));
    } catch (Exception e) {
      System.out.println("SCHEMA-INVALID\t" + e.getMessage());
      System.exit(2);
      return;
    }
    int failures = 0;
    for (int i = 1; i < args.length; i++) {
      Validator validator = schema.newValidator();
      try {
        validator.validate(new StreamSource(new File(args[i])));
        System.out.println("VALID\t" + args[i]);
      } catch (Exception e) {
        System.out.println("INVALID\t" + args[i] + "\t" + e.getMessage());
        failures++;
      }
    }
  }
}
